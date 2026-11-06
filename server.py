import os
import io
import re
import csv
import json
import hashlib
import sqlite3
import datetime
import urllib.parse
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import openpyxl

import database
import backup_manager

app = FastAPI(title="نظام كشف العملاء في الرحلات – المنفذ المثالي")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

def get_db():
    conn = database.get_connection()
    try:
        yield conn
    finally:
        conn.close()

# ----------------- Real-Time WebSocket Synchronization ----------------- #

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        dead_connections = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                dead_connections.append(connection)
        for dc in dead_connections:
            self.disconnect(dc)

manager = ConnectionManager()

async def broadcast_change(entity: str, action: str = "update"):
    await manager.broadcast({
        "type": "data_updated",
        "entity": entity,
        "action": action,
        "timestamp": datetime.datetime.now().isoformat()
    })

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except (WebSocketDisconnect, Exception):
        manager.disconnect(websocket)

@app.on_event("startup")
def on_startup():
    try:
        database.init_db()
        backup_manager.create_backup("server_start")
    except Exception as e:
        print("Startup warning:", e)

# ----------------- Models ----------------- #

class LoginRequest(BaseModel):
    username: str
    password: str

class TripCreate(BaseModel):
    name: str
    hijri_date: str
    gregorian_date: Optional[str] = ""
    hotel_name: Optional[str] = ""
    description: Optional[str] = ""
    bus_number: Optional[str] = ""
    driver_name: Optional[str] = ""
    driver_phone: Optional[str] = ""
    supervisor_name: Optional[str] = ""
    status: Optional[str] = "active"

class TripUpdate(BaseModel):
    name: Optional[str] = None
    hijri_date: Optional[str] = None
    gregorian_date: Optional[str] = None
    hotel_name: Optional[str] = None
    description: Optional[str] = None
    bus_number: Optional[str] = None
    driver_name: Optional[str] = None
    driver_phone: Optional[str] = None
    supervisor_name: Optional[str] = None
    status: Optional[str] = None

class CustomerCreate(BaseModel):
    trip_id: int
    full_name: str
    national_id: Optional[str] = ""
    phone: str
    pickup_point: str
    seat_number: Optional[str] = ""
    hotel_name: Optional[str] = ""
    room_number: Optional[str] = ""
    ticket_price: Optional[str] = "0"
    status: Optional[str] = "مسجل"
    notes: Optional[str] = ""

class CustomerUpdate(BaseModel):
    full_name: Optional[str] = None
    national_id: Optional[str] = None
    phone: Optional[str] = None
    pickup_point: Optional[str] = None
    seat_number: Optional[str] = None
    hotel_name: Optional[str] = None
    room_number: Optional[str] = None
    ticket_price: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None

class CustomerStatusUpdate(BaseModel):
    status: str
    notes: Optional[str] = None

class SettingsUpdate(BaseModel):
    settings: Dict[str, str]

class BulkAddCustomers(BaseModel):
    trip_id: int
    customers: List[Dict[str, Any]]

class ImportCommitRequest(BaseModel):
    trip_id: int
    rows: List[Dict[str, Any]]
    column_mapping: Dict[str, str]
    skip_duplicates: bool = False

# ----------------- Auth API ----------------- #

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

def _make_auth_token(user_id: int, password: str) -> str:
    sig = hashlib.sha256(f"manfath_secret_{user_id}_{password}".encode("utf-8")).hexdigest()[:24]
    return f"session-{user_id}-{sig}"

def _get_system_password(cursor: sqlite3.Cursor) -> str:
    cursor.execute("SELECT value FROM settings WHERE key = 'system_password'")
    row = cursor.fetchone()
    if row and row["value"]:
        return row["value"]
    cursor.execute("SELECT password FROM users WHERE username = 'admin'")
    u_row = cursor.fetchone()
    if u_row and u_row["password"]:
        return u_row["password"]
    return "123456"

@app.post("/api/auth/login")
def login(req: LoginRequest, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    sys_pass = _get_system_password(cursor)
    entered_pass = req.password.strip()
    entered_user = (req.username or "admin").strip()

    if entered_pass != sys_pass:
        raise HTTPException(status_code=401, detail="كلمة المرور غير صحيحة")

    cursor.execute("SELECT id, username, full_name, role, branch FROM users WHERE username = ?", (entered_user,))
    user = cursor.fetchone()
    if user:
        user_dict = dict(user)
    else:
        user_dict = {
            "id": 1,
            "username": entered_user or "admin",
            "full_name": "المشرف العام - المنفذ المثالي",
            "role": "admin",
            "branch": "الفرع الرئيسي"
        }

    return {
        "success": True,
        "user": user_dict,
        "token": _make_auth_token(user_dict["id"], sys_pass)
    }

@app.get("/api/auth/verify")
def verify_auth(token: str = Query(""), conn: sqlite3.Connection = Depends(get_db)):
    if not token or not token.startswith("session-"):
        raise HTTPException(status_code=401, detail="غير مصرح")
    cursor = conn.cursor()
    sys_pass = _get_system_password(cursor)
    parts = token.split("-")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail="رمز الجلسة غير صالح")
    try:
        uid = int(parts[1])
    except ValueError:
        raise HTTPException(status_code=401, detail="رمز الجلسة غير صالح")
    if token != _make_auth_token(uid, sys_pass):
        raise HTTPException(status_code=401, detail="انتهت صلاحية الجلسة أو تم تغيير كلمة المرور")
    return {"valid": True}

@app.post("/api/auth/change-password")
def change_password(req: ChangePasswordRequest, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    sys_pass = _get_system_password(cursor)
    if req.current_password.strip() != sys_pass:
        raise HTTPException(status_code=400, detail="كلمة المرور الحالية غير صحيحة")
    new_pass = req.new_password.strip()
    if len(new_pass) < 4:
        raise HTTPException(status_code=400, detail="يجب أن تتكون كلمة المرور الجديدة من 4 خانات على الأقل")

    cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('system_password', ?)", (new_pass,))
    cursor.execute("UPDATE users SET password = ?", (new_pass,))
    conn.commit()
    try:
        backup_manager.create_snapshot(reason="password_change")
    except Exception:
        pass

    return {
        "success": True,
        "message": "تم تغيير كلمة المرور بنجاح",
        "token": _make_auth_token(1, new_pass)
    }

# ----------------- Settings API ----------------- #

@app.get("/api/settings")
def get_settings(conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings WHERE key != 'system_password'")
    rows = cursor.fetchall()
    return {row["key"]: row["value"] for row in rows}

@app.post("/api/settings")
async def update_settings(req: SettingsUpdate, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    for k, v in req.settings.items():
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, str(v)))
    conn.commit()
    await broadcast_change("settings", "update")
    return {"success": True, "message": "تم حفظ الإعدادات بنجاح"}

# ----------------- Trips API ----------------- #

@app.get("/api/trips")
def get_trips(conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.*, 
            COUNT(c.id) as total_customers,
            SUM(CASE WHEN c.pickup_point LIKE '%شقراء%' THEN 1 ELSE 0 END) as shaqra_count,
            SUM(CASE WHEN c.pickup_point LIKE '%الدوادمي%' THEN 1 ELSE 0 END) as dawadmi_count,
            SUM(CASE WHEN c.status = 'مؤكد' THEN 1 ELSE 0 END) as confirmed_count,
            SUM(CASE WHEN c.status = 'مسجل' THEN 1 ELSE 0 END) as registered_count,
            SUM(CASE WHEN c.status = 'عدم الحضور' THEN 1 ELSE 0 END) as noshow_count,
            SUM(CASE WHEN c.status = 'ملغي' THEN 1 ELSE 0 END) as cancelled_count
        FROM trips t
        LEFT JOIN customers c ON t.id = c.trip_id
        GROUP BY t.id
        ORDER BY t.id DESC
    """)
    rows = cursor.fetchall()
    trips_list = []
    for r in rows:
        d = dict(r)
        d["shaqra_count"] = d["shaqra_count"] or 0
        d["dawadmi_count"] = d["dawadmi_count"] or 0
        d["confirmed_count"] = d["confirmed_count"] or 0
        d["registered_count"] = d["registered_count"] or 0
        d["noshow_count"] = d["noshow_count"] or 0
        d["cancelled_count"] = d["cancelled_count"] or 0
        trips_list.append(d)
    return trips_list

@app.get("/api/trips/{trip_id}")
def get_trip(trip_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.*, 
            COUNT(c.id) as total_customers,
            SUM(CASE WHEN c.pickup_point LIKE '%شقراء%' THEN 1 ELSE 0 END) as shaqra_count,
            SUM(CASE WHEN c.pickup_point LIKE '%الدوادمي%' THEN 1 ELSE 0 END) as dawadmi_count,
            SUM(CASE WHEN c.status = 'مؤكد' THEN 1 ELSE 0 END) as confirmed_count,
            SUM(CASE WHEN c.status = 'مسجل' THEN 1 ELSE 0 END) as registered_count,
            SUM(CASE WHEN c.status = 'عدم الحضور' THEN 1 ELSE 0 END) as noshow_count,
            SUM(CASE WHEN c.status = 'ملغي' THEN 1 ELSE 0 END) as cancelled_count
        FROM trips t
        LEFT JOIN customers c ON t.id = c.trip_id
        WHERE t.id = ?
        GROUP BY t.id
    """, (trip_id,))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="الرحلة غير موجودة")
    d = dict(row)
    d["shaqra_count"] = d["shaqra_count"] or 0
    d["dawadmi_count"] = d["dawadmi_count"] or 0
    d["confirmed_count"] = d["confirmed_count"] or 0
    d["registered_count"] = d["registered_count"] or 0
    d["noshow_count"] = d["noshow_count"] or 0
    d["cancelled_count"] = d["cancelled_count"] or 0
    return d

@app.post("/api/trips")
async def create_trip(trip: TripCreate, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("""
        INSERT INTO trips (name, hijri_date, gregorian_date, hotel_name, description, bus_number, driver_name, driver_phone, supervisor_name, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        trip.name, trip.hijri_date, trip.gregorian_date or "", trip.hotel_name or "",
        trip.description or "", trip.bus_number or "", trip.driver_name or "",
        trip.driver_phone or "", trip.supervisor_name or "", trip.status or "active",
        now_str, now_str
    ))
    conn.commit()
    new_id = cursor.lastrowid
    await broadcast_change("trips", "create")
    return {"success": True, "id": new_id, "message": "تمت إضافة الرحلة بنجاح"}

@app.put("/api/trips/{trip_id}")
async def update_trip(trip_id: int, trip: TripUpdate, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM trips WHERE id = ?", (trip_id,))
    if not cursor.fetchone():
        raise HTTPException(status_code=404, detail="الرحلة غير موجودة")

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    updates = []
    params = []
    for field, val in trip.model_dump(exclude_unset=True).items():
        if val is not None:
            updates.append(f"{field} = ?")
            params.append(val)
    
    if not updates:
        return {"success": True, "message": "لا يوجد تغييرات"}

    updates.append("updated_at = ?")
    params.append(now_str)
    params.append(trip_id)

    query = f"UPDATE trips SET {', '.join(updates)} WHERE id = ?"
    cursor.execute(query, params)
    conn.commit()
    await broadcast_change("trips", "update")
    return {"success": True, "message": "تم تحديث بيانات الرحلة بنجاح"}

@app.delete("/api/trips/{trip_id}")
async def delete_trip(trip_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM customers WHERE trip_id = ?", (trip_id,))
    cursor.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
    conn.commit()
    await broadcast_change("trips", "delete")
    return {"success": True, "message": "تم حذف الرحلة وسجلاتها بنجاح"}

@app.post("/api/trips/{trip_id}/archive")
async def archive_trip_endpoint(trip_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id, name FROM trips WHERE id = ?", (trip_id,))
    trip = cursor.fetchone()
    if not trip:
        raise HTTPException(status_code=404, detail="الرحلة غير موجودة")
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("UPDATE trips SET status = 'archived', updated_at = ? WHERE id = ?", (now_str, trip_id))
    conn.commit()
    await broadcast_change("trips", "archive")
    return {"success": True, "message": f"تم نقل ({trip['name']}) إلى أرشيف الرحلات بنجاح"}

@app.post("/api/trips/{trip_id}/restore")
async def restore_trip_endpoint(trip_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id, name FROM trips WHERE id = ?", (trip_id,))
    trip = cursor.fetchone()
    if not trip:
        raise HTTPException(status_code=404, detail="الرحلة غير موجودة")
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("UPDATE trips SET status = 'active', updated_at = ? WHERE id = ?", (now_str, trip_id))
    conn.commit()
    await broadcast_change("trips", "restore")
    return {"success": True, "message": f"تمت استعادة ({trip['name']}) إلى الرحلات النشطة بنجاح"}

# ----------------- Customers API ----------------- #

@app.get("/api/customers")
def get_customers(
    trip_id: Optional[int] = None,
    pickup_point: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    hotel: Optional[str] = None,
    limit: int = 500,
    offset: int = 0,
    conn: sqlite3.Connection = Depends(get_db)
):
    cursor = conn.cursor()
    query = """
        SELECT c.*, t.name as trip_name, t.hijri_date as trip_hijri_date, t.hotel_name as trip_hotel
        FROM customers c
        JOIN trips t ON c.trip_id = t.id
        WHERE 1=1
    """
    params = []

    if trip_id:
        query += " AND c.trip_id = ?"
        params.append(trip_id)

    if pickup_point and pickup_point != "الكل":
        query += " AND c.pickup_point LIKE ?"
        params.append(f"%{pickup_point}%")

    if status and status != "الكل":
        query += " AND c.status = ?"
        params.append(status)

    if hotel and hotel != "الكل":
        query += " AND (c.hotel_name LIKE ? OR t.hotel_name LIKE ?)"
        params.append(f"%{hotel}%")
        params.append(f"%{hotel}%")

    if search:
        search_param = f"%{search.strip()}%"
        query += """ AND (
            c.full_name LIKE ? OR 
            c.national_id LIKE ? OR 
            c.phone LIKE ? OR 
            c.seat_number LIKE ? OR 
            c.card_number LIKE ? OR 
            c.customer_number LIKE ? OR
            t.name LIKE ?
        )"""
        params.extend([search_param] * 7)

    query += " ORDER BY c.pickup_point DESC, CAST(c.seat_number AS INTEGER) ASC, c.id ASC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    cursor.execute(query, params)
    rows = cursor.fetchall()
    return [dict(r) for r in rows]

@app.get("/api/customers/{customer_id}")
def get_customer(customer_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("""
        SELECT c.*, t.name as trip_name, t.hijri_date as trip_hijri_date, t.gregorian_date as trip_gregorian_date,
               t.hotel_name as trip_hotel, t.bus_number, t.driver_name, t.driver_phone, t.supervisor_name
        FROM customers c
        JOIN trips t ON c.trip_id = t.id
        WHERE c.id = ?
    """, (customer_id,))
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="العميل غير موجود")
    return dict(row)

@app.post("/api/customers")
async def create_customer(cust: CustomerCreate, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT name, hijri_date, hotel_name FROM trips WHERE id = ?", (cust.trip_id,))
    trip = cursor.fetchone()
    if not trip:
        raise HTTPException(status_code=400, detail="الرحلة المحددة غير موجودة")

    cursor.execute("SELECT COUNT(*) FROM customers")
    total_cust = cursor.fetchone()[0] + 1
    
    trip_prefix = f"TRIP-{cust.trip_id:02d}"
    pickup_code = "SHQ" if "شقراء" in cust.pickup_point else "DAW"
    card_num = f"{trip_prefix}-{pickup_code}-{total_cust:04d}"
    cust_num = f"CUST-{total_cust:04d}"
    
    seat = cust.seat_number
    if not seat:
        cursor.execute("SELECT MAX(CAST(seat_number AS INTEGER)) FROM customers WHERE trip_id = ?", (cust.trip_id,))
        max_seat = cursor.fetchone()[0] or 0
        seat = str(max_seat + 1)

    hotel = cust.hotel_name or trip["hotel_name"] or ""
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cursor.execute("""
        INSERT INTO customers (trip_id, customer_number, card_number, full_name, national_id, phone, pickup_point, seat_number, hotel_name, room_number, ticket_price, status, notes, registered_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        cust.trip_id, cust_num, card_num, cust.full_name.strip(),
        cust.national_id.strip() if cust.national_id else "",
        cust.phone.strip(), cust.pickup_point.strip(), str(seat),
        hotel, cust.room_number or "", cust.ticket_price or "0", cust.status or "مسجل",
        cust.notes or "", trip["hijri_date"], now_str
    ))
    conn.commit()
    new_id = cursor.lastrowid
    await broadcast_change("customers", "create")
    return {"success": True, "id": new_id, "card_number": card_num, "message": "تم تسجيل العميل بنجاح"}

@app.put("/api/customers/{customer_id}")
async def update_customer(customer_id: int, cust: CustomerUpdate, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM customers WHERE id = ?", (customer_id,))
    if not cursor.fetchone():
        raise HTTPException(status_code=404, detail="العميل غير موجود")

    updates = []
    params = []
    for field, val in cust.model_dump(exclude_unset=True).items():
        if val is not None:
            updates.append(f"{field} = ?")
            params.append(val)

    if not updates:
        return {"success": True, "message": "لا توجد تعديلات"}

    params.append(customer_id)
    query = f"UPDATE customers SET {', '.join(updates)} WHERE id = ?"
    cursor.execute(query, params)
    conn.commit()
    await broadcast_change("customers", "update")
    return {"success": True, "message": "تم تحديث بيانات العميل بنجاح"}

@app.patch("/api/customers/{customer_id}/status")
async def update_customer_status(customer_id: int, req: CustomerStatusUpdate, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id, status, notes FROM customers WHERE id = ?", (customer_id,))
    cust = cursor.fetchone()
    if not cust:
        raise HTTPException(status_code=404, detail="العميل غير موجود")

    notes = req.notes if req.notes is not None else cust["notes"]
    if req.status == "عدم الحضور" and not notes:
        notes = "لم يحضر في نقطة التجمع - يتطلب التواصل والمتابعة فوراً"

    cursor.execute("UPDATE customers SET status = ?, notes = ? WHERE id = ?", (req.status, notes, customer_id))
    conn.commit()
    await broadcast_change("customers", "status")
    return {"success": True, "status": req.status, "message": f"تم تغيير حالة العميل إلى ({req.status})"}

@app.delete("/api/customers/{customer_id}")
async def delete_customer(customer_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("DELETE FROM customers WHERE id = ?", (customer_id,))
    conn.commit()
    await broadcast_change("customers", "delete")
    return {"success": True, "message": "تم حذف العميل بنجاح"}

class BatchDeleteRequest(BaseModel):
    customer_ids: List[int]

@app.post("/api/customers/batch-delete")
async def batch_delete_customers(req: BatchDeleteRequest, conn: sqlite3.Connection = Depends(get_db)):
    if not req.customer_ids:
        return {"success": True, "message": "لا يوجد عملاء للحذف"}
    cursor = conn.cursor()
    placeholders = ",".join("?" for _ in req.customer_ids)
    cursor.execute(f"DELETE FROM customers WHERE id IN ({placeholders})", req.customer_ids)
    conn.commit()
    await broadcast_change("customers", "delete")
    return {"success": True, "message": f"تم حذف {len(req.customer_ids)} عميل بنجاح"}

class BatchStatusUpdateRequest(BaseModel):
    trip_id: Optional[int] = None
    customer_ids: Optional[List[int]] = None
    status: str
    previous_status: Optional[str] = None

@app.post("/api/customers/batch-status")
async def batch_update_status(req: BatchStatusUpdateRequest, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    valid_statuses = ["مسجل", "مؤكد", "عدم الحضور", "ملغي"]
    if req.status not in valid_statuses:
        raise HTTPException(status_code=400, detail="الحالة غير صالحة")

    query = "UPDATE customers SET status = ? WHERE 1=1"
    params = [req.status]

    if req.trip_id is not None:
        query += " AND trip_id = ?"
        params.append(req.trip_id)

    if req.customer_ids:
        placeholders = ",".join("?" for _ in req.customer_ids)
        query += f" AND id IN ({placeholders})"
        params.extend(req.customer_ids)

    if req.previous_status and req.previous_status != "الكل":
        query += " AND status = ?"
        params.append(req.previous_status)

    cursor.execute(query, params)
    updated_count = cursor.rowcount
    conn.commit()
    await broadcast_change("customers", "status")
    return {
        "success": True,
        "updated_count": updated_count,
        "status": req.status,
        "message": f"تم تعديل حالة {updated_count} راكب إلى ({req.status}) بنجاح"
    }

# ----------------- Excel / CSV Import API ----------------- #

EXCEL_ARABIC_DIGITS_MAP = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")

def format_excel_cell(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, bool):
        return ""
    if isinstance(val, int):
        return str(val)
    if isinstance(val, float):
        if val.is_integer():
            return str(int(val))
        return str(val)
    s = str(val)
    # Remove invisible formatting characters (RTL/LTR marks, zero-width spaces, BOM, non-breaking spaces)
    for ch in ("\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\ufeff", "\u202a", "\u202b", "\u202c"):
        s = s.replace(ch, "")
    s = s.replace("\xa0", " ")
    # Collapse multiple spaces/newlines into single space
    s = re.sub(r"\s+", " ", s).strip()
    # Handle strings that look like float integers e.g. "551234567.0"
    if re.match(r"^\d+\.0+$", s):
        s = s.split(".")[0]
    return s

def normalize_arabic_name(name: str) -> str:
    s = format_excel_cell(name)
    s = re.sub(r"[أإآ]", "ا", s)
    s = s.replace("ة", "ه").replace("ى", "ي")
    s = re.sub(r"\s+", " ", s).strip()
    return s

HEADER_KEYWORDS = [
    "اسم", "الاسم", "العميل", "الراكب", "المعتمر", "الحاج", "المسافر", "الرباعي", "الثلاثي",
    "هوية", "الهوية", "سجل", "اقامة", "إقامة", "جواز",
    "جوال", "الجوال", "هاتف", "الهاتف", "تواصل", "الاتصال", "رقم",
    "صعود", "الصعود", "نقطة", "الموقع", "المدينة", "الفرع", "فرع",
    "مقعد", "المقعد", "كرسي",
    "فندق", "الفندق", "غرفة", "الغرفة", "تسكين",
    "حالة", "الحالة", "تذكرة", "التذكرة", "سعر", "مبلغ", "متبقي", "ملاحظة", "ملاحظات",
    "name", "passenger", "customer", "phone", "mobile", "id", "national", "seat", "pickup", "hotel", "room", "status", "notes", "price"
]

SUMMARY_OR_HEADER_WORDS = {
    "الاسم", "اسم العميل", "اسم الراكب", "العميل", "الراكب", "اسم المعتمر", "الاسم الكامل", "الاسم الرباعي",
    "المجموع", "الإجمالي", "الاجمالي", "اجمالي", "إجمالي", "مجموع", "عدد الركاب", "التوقيع", "ملاحظات", "name", "full name", "total"
}

def _is_likely_header_row(row_cells: List[str]) -> bool:
    non_empty = [c for c in row_cells if c]
    if not non_empty:
        return False
    keyword_hits = 0
    for c in non_empty:
        c_low = c.lower()
        # A header cell is usually short (< 35 chars) and contains a header keyword
        if len(c_low) < 40 and any(k in c_low for k in HEADER_KEYWORDS):
            keyword_hits += 1
    return keyword_hits >= 1

def _make_unique_headers(raw_headers: List[str]) -> List[str]:
    headers = []
    seen = {}
    for i, h in enumerate(raw_headers):
        clean_h = format_excel_cell(h)
        if not clean_h:
            clean_h = f"عمود_{i+1}"
        if clean_h in seen:
            seen[clean_h] += 1
            clean_h = f"{clean_h} ({seen[clean_h]})"
        else:
            seen[clean_h] = 1
        headers.append(clean_h)
    return headers

@app.post("/api/import/preview")
async def preview_import_file(file: UploadFile = File(...)):
    filename = file.filename.lower()
    content = await file.read()

    rows = []
    headers = []

    if filename.endswith(".xlsx") or filename.endswith(".xls"):
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
        # Pick the sheet with the most non-empty rows (in case active sheet is empty or not the main one)
        best_sheet_rows = []
        for sheet in wb.worksheets:
            s_rows = []
            for r in sheet.iter_rows(values_only=True):
                formatted_r = [format_excel_cell(cell) for cell in r]
                if any(formatted_r):
                    s_rows.append(formatted_r)
            if len(s_rows) > len(best_sheet_rows):
                best_sheet_rows = s_rows

        all_rows = best_sheet_rows
        if not all_rows:
            raise HTTPException(status_code=400, detail="الملف فارغ لا يحتوي على بيانات")

    elif filename.endswith(".csv") or filename.endswith(".txt"):
        text = None
        for enc in ["utf-8-sig", "utf-8", "windows-1256", "iso-8859-6", "latin-1"]:
            try:
                text = content.decode(enc)
                break
            except Exception:
                continue
        if text is None:
            raise HTTPException(status_code=400, detail="تعذر قراءة ترميز ملف CSV")

        reader = csv.reader(io.StringIO(text))
        all_rows = []
        for r in reader:
            formatted_r = [format_excel_cell(cell) for cell in r]
            if any(formatted_r):
                all_rows.append(formatted_r)
        if not all_rows:
            raise HTTPException(status_code=400, detail="الملف فارغ")
    else:
        raise HTTPException(status_code=400, detail="صيغة الملف غير مدعومة. يرجى رفع ملف XLSX أو XLS أو CSV")

    # Find max columns across all rows
    max_cols = max(len(r) for r in all_rows)
    padded_rows = [r + [""] * (max_cols - len(r)) for r in all_rows]

    # Smart header detection: look in first 10 rows for a real table header row
    header_idx = None
    for idx in range(min(10, len(padded_rows))):
        r = padded_rows[idx]
        non_empty = [c for c in r if c]
        # Skip single-cell title rows (e.g. "كشف ركاب رحلة مكة") when subsequent rows have multiple columns
        if len(non_empty) == 1 and max_cols >= 2 and idx + 1 < len(padded_rows):
            if not _is_likely_header_row(r):
                continue
        if _is_likely_header_row(r):
            header_idx = idx
            break

    if header_idx is not None:
        headers = _make_unique_headers(padded_rows[header_idx])
        data_rows = padded_rows[header_idx + 1:]
    else:
        # No header keywords found! Check if row 0 is a single-cell title or actual passenger data
        start_idx = 0
        while start_idx < len(padded_rows) and sum(1 for c in padded_rows[start_idx] if c) == 1 and max_cols >= 2:
            # Check if this single cell looks like a title (contains رحلة / كشف / بسم الله)
            first_cell = next(c for c in padded_rows[start_idx] if c)
            if any(w in first_cell for w in ["كشف", "رحلة", "بيان", "قائمة", "بسم الله", "فرع"]):
                start_idx += 1
            else:
                break
        # Synthesize column headers so we DO NOT lose passenger #1 as a header!
        headers = [f"عمود_{i+1}" for i in range(max_cols)]
        data_rows = padded_rows[start_idx:]

    for r in data_rows:
        if not any(r):
            continue
        # Skip repeated header rows inside the sheet (e.g., page breaks in Excel)
        non_empty_vals = [c for c in r if c]
        if len(non_empty_vals) >= 2 and all(c in headers or c.lower() in SUMMARY_OR_HEADER_WORDS for c in non_empty_vals):
            continue
        row_dict = {headers[i]: r[i] for i in range(len(headers))}
        if any(row_dict.values()):
            rows.append(row_dict)

    mapping_suggestions = {}
    for col in headers:
        c_low = col.lower()
        # Check specific columns BEFORE generic "اسم" so "اسم الفندق" or "اسم المشرف" never overwrites full_name
        if any(k in c_low for k in ["فندق", "الفندق", "hotel"]):
            mapping_suggestions.setdefault("hotel_name", col)
        elif any(k in c_low for k in ["غرفة", "الغرفة", "تسكين", "room"]):
            mapping_suggestions.setdefault("room_number", col)
        elif any(k in c_low for k in ["صعود", "الصعود", "نقطة", "الموقع", "المدينة", "pickup", "location", "branch", "فرع"]):
            mapping_suggestions.setdefault("pickup_point", col)
        elif any(k in c_low for k in ["مقعد", "المقعد", "كرسي", "seat", "chair"]):
            mapping_suggestions.setdefault("seat_number", col)
        elif any(k in c_low for k in ["هوية", "الهوية", "سجل", "اقامة", "إقامة", "جواز", "national"]):
            mapping_suggestions.setdefault("national_id", col)
        elif any(k in c_low for k in ["جوال", "الجوال", "هاتف", "الهاتف", "تواصل", "phone", "mobile", "رقم الاتصال"]):
            mapping_suggestions.setdefault("phone", col)
        elif any(k in c_low for k in ["حالة", "الحالة", "status"]):
            mapping_suggestions.setdefault("status", col)
        elif any(k in c_low for k in ["تذكرة", "التذكرة", "سعر", "قيمة", "مبلغ", "المتبقي", "باقي", "متبقي", "price", "ticket", "remaining", "balance"]):
            mapping_suggestions.setdefault("ticket_price", col)
        elif any(k in c_low for k in ["ملاحظة", "ملاحظات", "note", "notes"]):
            mapping_suggestions.setdefault("notes", col)
        elif any(k in c_low for k in ["اسم", "الاسم", "العميل", "الراكب", "المعتمر", "الحاج", "المسافر", "name", "passenger", "customer"]):
            if not any(excl in c_low for excl in ["فندق", "رحلة", "مشرف", "سائق", "باص", "حافلة", "فرع", "نقطة"]):
                mapping_suggestions.setdefault("full_name", col)

    # Fallback heuristic: if full_name or phone wasn't detected from header names, inspect sample data values
    if rows:
        sample = rows[:min(15, len(rows))]
        if "full_name" not in mapping_suggestions:
            best_name_col = None
            best_name_score = 0
            for col in headers:
                if col in mapping_suggestions.values():
                    continue
                score = 0
                for r in sample:
                    val = r.get(col, "")
                    # Looks like a person name: contains letters, at least 3 chars, not purely digits
                    if val and len(val) >= 3 and not val.translate(EXCEL_ARABIC_DIGITS_MAP).isdigit():
                        if re.search(r"[\u0600-\u06FFa-zA-Z]", val):
                            score += 2 if " " in val else 1
                if score > best_name_score:
                    best_name_score = score
                    best_name_col = col
            if best_name_col:
                mapping_suggestions["full_name"] = best_name_col

        if "phone" not in mapping_suggestions:
            for col in headers:
                if col in mapping_suggestions.values():
                    continue
                phone_hits = 0
                for r in sample:
                    val_digits = re.sub(r"[^\d]", "", r.get(col, "").translate(EXCEL_ARABIC_DIGITS_MAP))
                    if len(val_digits) in (9, 10, 12) and (val_digits.startswith("05") or val_digits.startswith("5") or val_digits.startswith("9665")):
                        phone_hits += 1
                if phone_hits >= max(1, len(sample) // 3):
                    mapping_suggestions["phone"] = col
                    break

    return {
        "success": True,
        "total_rows": len(rows),
        "headers": headers,
        "mapping_suggestions": mapping_suggestions,
        "sample_rows": rows,
        "all_rows": rows
    }

@app.post("/api/import/commit")
async def commit_import(req: ImportCommitRequest, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id, name, hijri_date, hotel_name FROM trips WHERE id = ?", (req.trip_id,))
    trip = cursor.fetchone()
    if not trip:
        raise HTTPException(status_code=400, detail="الرحلة المحددة غير موجودة")

    cursor.execute("SELECT COUNT(*) FROM customers")
    total_cust = cursor.fetchone()[0]

    cursor.execute("SELECT full_name, phone, national_id FROM customers WHERE trip_id = ?", (req.trip_id,))
    existing_records = cursor.fetchall()
    # Track exact (normalized_name, phone) and (normalized_name, national_id) pairs so family members sharing a phone are NEVER skipped
    existing_name_Check = set()
    for r in existing_records:
        n_norm = normalize_arabic_name(r["full_name"] or "")
        p_clean = (r["phone"] or "").strip()
        id_clean = (r["national_id"] or "").strip()
        if n_norm:
            existing_name_Check.add((n_norm, p_clean, id_clean))

    cursor.execute("SELECT MAX(CAST(seat_number AS INTEGER)) FROM customers WHERE trip_id = ?", (req.trip_id,))
    max_seat = cursor.fetchone()[0] or 0

    inserted_count = 0
    skipped_count = 0
    skipped_details = []
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    col_map = req.column_mapping
    mapped_cols_set = {v for v in col_map.values() if v}

    for row_idx, row in enumerate(req.rows, start=1):
        full_name = format_excel_cell(row.get(col_map.get("full_name", ""), ""))

        # Fallback: if full_name is empty in the mapped column (e.g. merged cell or shifted column in Excel),
        # check if there is another unmapped column in this row that clearly holds a person's name
        if not full_name:
            for k, v in row.items():
                if k not in mapped_cols_set:
                    cand = format_excel_cell(v)
                    cand_digits = cand.translate(EXCEL_ARABIC_DIGITS_MAP)
                    if cand and len(cand) >= 3 and not cand_digits.isdigit() and re.search(r"[\u0600-\u06FFa-zA-Z]", cand):
                        if cand.lower() not in SUMMARY_OR_HEADER_WORDS:
                            full_name = cand
                            break

        if not full_name:
            continue

        # Ignore repeated header rows or footer summary rows ("الإجمالي", "المجموع", "الاسم")
        if full_name.lower() in SUMMARY_OR_HEADER_WORDS:
            continue
        # Ignore rows where full_name is purely a serial number (e.g. "1", "2")
        if full_name.translate(EXCEL_ARABIC_DIGITS_MAP).isdigit():
            continue

        phone_raw = format_excel_cell(row.get(col_map.get("phone", ""), "")).translate(EXCEL_ARABIC_DIGITS_MAP)
        phone_clean = re.sub(r"[^\d]", "", phone_raw)
        if phone_clean.startswith("00966"):
            phone_clean = "0" + phone_clean[5:]
        elif phone_clean.startswith("966") and len(phone_clean) >= 11:
            phone_clean = "0" + phone_clean[3:]
        elif not phone_clean.startswith("0") and len(phone_clean) == 9 and phone_clean.startswith("5"):
            phone_clean = "0" + phone_clean
        # Ignore placeholder phones like "0" or "00"
        if len(phone_clean) < 5:
            phone_clean = ""

        id_raw = format_excel_cell(row.get(col_map.get("national_id", ""), "")).translate(EXCEL_ARABIC_DIGITS_MAP)
        national_id = re.sub(r"[^\d]", "", id_raw)
        # Ignore placeholder IDs like "0", "0000", "1"
        if len(national_id) < 5 or set(national_id) == {"0"}:
            national_id = ""

        norm_name = normalize_arabic_name(full_name)

        if req.skip_duplicates:
            # Only skip if BOTH the normalized name AND (phone or national_id) match an existing passenger!
            # This guarantees family members sharing a phone number are NEVER skipped.
            is_dup = False
            for ex_name, ex_phone, ex_id in existing_name_Check:
                if ex_name == norm_name:
                    if (phone_clean and phone_clean == ex_phone) or (national_id and national_id == ex_id) or (not phone_clean and not national_id):
                        is_dup = True
                        break
            if is_dup:
                skipped_count += 1
                skipped_details.append(f"صف {row_idx}: {full_name} (مكرر)")
                continue

        pickup_raw = format_excel_cell(row.get(col_map.get("pickup_point", ""), ""))
        if "دوادم" in pickup_raw or "daw" in pickup_raw.lower():
            pickup_point = "الدوادمي"
        elif "شقراء" in pickup_raw or "shaq" in pickup_raw.lower():
            pickup_point = "شقراء"
        else:
            pickup_point = pickup_raw if pickup_raw else "شقراء"

        seat_raw = format_excel_cell(row.get(col_map.get("seat_number", ""), "")).translate(EXCEL_ARABIC_DIGITS_MAP)
        seat_digits = re.sub(r"[^\d]", "", seat_raw)
        if seat_digits and int(seat_digits) > 0:
            seat_number = str(int(seat_digits))
            if int(seat_digits) > max_seat:
                max_seat = int(seat_digits)
        else:
            max_seat += 1
            seat_number = str(max_seat)

        hotel = format_excel_cell(row.get(col_map.get("hotel_name", ""), "")) or trip["hotel_name"] or ""
        room = format_excel_cell(row.get(col_map.get("room_number", ""), ""))

        status_raw = format_excel_cell(row.get(col_map.get("status", ""), ""))
        if "مؤكد" in status_raw:
            status = "مؤكد"
        elif "عدم" in status_raw or "غائب" in status_raw:
            status = "عدم الحضور"
        elif "ملغ" in status_raw:
            status = "ملغي"
        else:
            status = "مسجل"

        notes = format_excel_cell(row.get(col_map.get("notes", ""), ""))
        ticket_price_raw = format_excel_cell(row.get(col_map.get("ticket_price", ""), "")).translate(EXCEL_ARABIC_DIGITS_MAP)
        ticket_price = ticket_price_raw if ticket_price_raw else "0"

        total_cust += 1
        trip_prefix = f"TRIP-{trip['id']:02d}"
        pickup_code = "SHQ" if "شقراء" in pickup_point else "DAW"
        card_num = f"{trip_prefix}-{pickup_code}-{total_cust:04d}"
        cust_num = f"CUST-{total_cust:04d}"

        cursor.execute("""
            INSERT INTO customers (trip_id, customer_number, card_number, full_name, national_id, phone, pickup_point, seat_number, hotel_name, room_number, ticket_price, status, notes, registered_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            trip["id"], cust_num, card_num, full_name, national_id, phone_clean,
            pickup_point, seat_number, hotel, room, ticket_price, status, notes, trip["hijri_date"], now_str
        ))

        existing_name_Check.add((norm_name, phone_clean, national_id))
        inserted_count += 1

    conn.commit()
    await broadcast_change("customers", "import")
    msg = f"تم استيراد {inserted_count} راكب بنجاح"
    if skipped_count > 0:
        msg += f" (تم تخطي {skipped_count} لتكرار نفس الاسم والجوال)"
    return {
        "success": True,
        "inserted_count": inserted_count,
        "skipped_count": skipped_count,
        "skipped_details": skipped_details,
        "message": msg
    }

# ----------------- VCF Contacts Export API ----------------- #

ARABIC_DIGITS_MAP = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")

def clean_phone_number(phone_str: Any) -> str:
    if not phone_str:
        return ""
    s = str(phone_str).translate(ARABIC_DIGITS_MAP)
    return "".join(ch for ch in s if ch.isdigit() or ch == "+")

@app.get("/api/export/vcf/{trip_id}")
def export_vcf(trip_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT name, hijri_date FROM trips WHERE id = ?", (trip_id,))
    trip = cursor.fetchone()
    if not trip:
        raise HTTPException(status_code=404, detail="الرحلة غير موجودة")

    cursor.execute("SELECT id, full_name, phone, pickup_point, seat_number, hotel_name FROM customers WHERE trip_id = ? ORDER BY pickup_point DESC, seat_number ASC", (trip_id,))
    customers = cursor.fetchall()

    vcard_lines = []
    trip_name = trip["name"].strip()
    now_stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    for c in customers:
        full_name = (c["full_name"] or "").strip()
        if not full_name:
            continue

        phone = clean_phone_number(c["phone"])
        pickup = (c["pickup_point"] or "").strip()
        seat = (c["seat_number"] or "").strip()
        hotel = (c["hotel_name"] or "").strip()
        cust_id = c["id"]

        # Format requested: حفظ الرقم باسم الشخص وبجانبه يكتب - اسم الرحلة
        display_name = f"{full_name} - {trip_name}"

        # RFC 2426 compliant vCard 3.0 (Strictly iOS & Android compatible)
        vcard_lines.append("BEGIN:VCARD")
        vcard_lines.append("VERSION:3.0")
        vcard_lines.append("PRODID:-//AlManfath Trips//Trip Contacts//AR")
        vcard_lines.append(f"UID:almanfath-cust-{trip_id}-{cust_id}")
        vcard_lines.append(f"FN:{display_name}")
        vcard_lines.append(f"N:;{display_name};;;")
        if phone:
            vcard_lines.append(f"TEL;TYPE=CELL,VOICE:{phone}")
        if pickup:
            vcard_lines.append(f"ORG:المنفذ المثالي - {pickup}")
        if seat or trip_name:
            vcard_lines.append(f"TITLE:مقعد: {seat} | {trip_name}")
        vcard_lines.append(f"NOTE:نقطة الصعود: {pickup} | رقم المقعد: {seat} | الفندق: {hotel}")
        vcard_lines.append(f"REV:{now_stamp}")
        vcard_lines.append("END:VCARD")
        vcard_lines.append("")

    vcard_content = "\r\n".join(vcard_lines)
    encoded_filename = urllib.parse.quote(f"جهات_اتصال_{trip_name}.vcf")

    return Response(
        content=vcard_content.encode("utf-8"),
        media_type="text/vcard; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
            "Cache-Control": "no-cache, no-store, must-revalidate"
        }
    )

# ----------------- Excel Export API ----------------- #

@app.get("/api/export/excel/{trip_id}")
def export_trip_excel(trip_id: int, conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM trips WHERE id = ?", (trip_id,))
    trip = cursor.fetchone()
    if not trip:
        raise HTTPException(status_code=404, detail="الرحلة غير موجودة")

    cursor.execute("SELECT * FROM customers WHERE trip_id = ? ORDER BY pickup_point DESC, CAST(seat_number AS INTEGER) ASC", (trip_id,))
    customers = cursor.fetchall()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "كشف ركاب الرحلة"
    ws.views.sheetView[0].rightToLeft = True

    ws.append(["المنفذ المثالي لتنظيم الرحلات السياحية"])
    ws.append([f"كشف تسجيل العملاء: {trip['name']} - التاريخ: {trip['hijri_date']} - الفندق: {trip['hotel_name']}"])
    ws.append([])

    headers = ["م", "اسم العميل", "رقم الهوية", "رقم الجوال", "نقطة الصعود", "رقم المقعد", "الفندق / الغرفة", "حالة التسجيل", "المبلغ المتبقي", "ملاحظات"]
    ws.append(headers)

    for idx, c in enumerate(customers, 1):
        ws.append([
            idx,
            c["full_name"],
            c["national_id"],
            c["phone"],
            c["pickup_point"],
            c["seat_number"],
            f"{c['hotel_name']} - {c['room_number']}" if c["room_number"] else c["hotel_name"],
            c["status"],
            f"{c['ticket_price'] or '0'} ريال",
            c["notes"]
        ])

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    encoded_filename = urllib.parse.quote(f"كشف_ركاب_{trip['name']}.xlsx")
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"
        }
    )

# ----------------- Stats & Dashboard API ----------------- #

@app.get("/api/stats")
def get_stats(conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()

    cursor.execute("SELECT COUNT(*) FROM trips")
    total_trips = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM customers")
    total_customers = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM customers WHERE pickup_point LIKE '%شقراء%'")
    shaqra_customers = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM customers WHERE pickup_point LIKE '%الدوادمي%'")
    dawadmi_customers = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM customers WHERE status = 'مؤكد'")
    confirmed_customers = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM customers WHERE status = 'مسجل'")
    registered_customers = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM customers WHERE status = 'عدم الحضور'")
    noshow_customers = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM customers WHERE status = 'ملغي'")
    cancelled_customers = cursor.fetchone()[0]

    cursor.execute("SELECT * FROM trips ORDER BY id DESC LIMIT 1")
    latest_trip_row = cursor.fetchone()
    latest_trip = dict(latest_trip_row) if latest_trip_row else None

    return {
        "total_trips": total_trips,
        "total_customers": total_customers,
        "shaqra_customers": shaqra_customers,
        "dawadmi_customers": dawadmi_customers,
        "confirmed_customers": confirmed_customers,
        "registered_customers": registered_customers,
        "noshow_customers": noshow_customers,
        "cancelled_customers": cancelled_customers,
        "latest_trip": latest_trip
    }

# ----------------- Database Backup & Reset API ----------------- #

@app.get("/api/backup/export")
def export_backup(conn: sqlite3.Connection = Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM settings")
    settings = [dict(r) for r in cursor.fetchall()]

    cursor.execute("SELECT * FROM trips")
    trips = [dict(r) for r in cursor.fetchall()]

    cursor.execute("SELECT * FROM customers")
    customers = [dict(r) for r in cursor.fetchall()]

    backup_data = {
        "app": "Al-Manfath Al-Mithali Trips System",
        "version": "1.0",
        "exported_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "settings": settings,
        "trips": trips,
        "customers": customers
    }
    return backup_data

@app.get("/api/backup/download")
def download_database_backup():
    filename = backup_manager.create_backup("manual_download")
    filepath = os.path.join(database.BACKUPS_DIR, filename)
    return FileResponse(
        path=filepath,
        filename=filename,
        media_type="application/octet-stream"
    )

@app.get("/api/backup/list")
def list_database_backups():
    return backup_manager.list_backups()

@app.post("/api/backup/create")
def trigger_manual_backup():
    filename = backup_manager.create_backup("manual")
    return {"success": True, "message": "تم إنشاء نسخة احتياطية جديدة بنجاح", "filename": filename}

@app.post("/api/backup/restore/{filename}")
async def restore_database_backup(filename: str):
    try:
        backup_manager.restore_backup(filename)
        await broadcast_change("system", "restore")
        return {"success": True, "message": f"تمت استعادة النسخة الاحتياطية ({filename}) بنجاح"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/backup/upload")
async def upload_database_backup(file: UploadFile = File(...)):
    if not file.filename.endswith(".db"):
        raise HTTPException(status_code=400, detail="يجب أن يكون الملف بصيغة قاعدة بيانات SQLite (.db)")
    backup_manager.ensure_backup_dir()
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    saved_filename = f"almanfath_uploaded_{timestamp}.db"
    saved_filepath = os.path.join(database.BACKUPS_DIR, saved_filename)
    with open(saved_filepath, "wb") as f:
        content = await file.read()
        f.write(content)
    # Restore from uploaded file
    backup_manager.restore_backup(saved_filename)
    await broadcast_change("system", "restore")
    return {"success": True, "message": "تم رفع واستعادة النسخة الاحتياطية بنجاح"}

@app.post("/api/reset-demo")
def reset_demo_data():
    conn = database.get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM customers")
    cursor.execute("DELETE FROM trips")
    database.seed_data(conn)
    conn.close()
    return {"success": True, "message": "تمت إعادة ضبط البيانات التجريبية بنجاح"}

@app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
def index():
    html_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>نظام المنفذ المثالي - جاري تحميل الملفات...</h1>"

@app.api_route("/healthz", methods=["GET", "HEAD"])
def health_check():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)