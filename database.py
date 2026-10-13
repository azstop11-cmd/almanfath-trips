import sqlite3
import os
import json
import datetime
import random
import shutil

DATA_DIR = os.getenv("DATA_DIR", os.path.dirname(__file__))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.getenv("DB_PATH", os.path.join(DATA_DIR, "almanfath_trips.db"))
BACKUPS_DIR = os.getenv("BACKUPS_DIR", os.path.join(DATA_DIR, "backups"))
os.makedirs(BACKUPS_DIR, exist_ok=True)

# Auto-seed existing database if deploying on fresh cloud storage
SEED_PATH = os.path.join(os.path.dirname(__file__), "initial_seed.db")
if not os.path.exists(DB_PATH) and os.path.exists(SEED_PATH):
    try:
        shutil.copyfile(SEED_PATH, DB_PATH)
        print("Seeded database from initial_seed.db")
    except Exception as e:
        print("Error seeding database:", e)

def get_connection():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
    except Exception:
        pass
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    # Settings table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """)

    # Users table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        full_name TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        branch TEXT DEFAULT 'شقراء والدوادمي',
        created_at TEXT
    );
    """)

    # Trips table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS trips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        hijri_date TEXT NOT NULL,
        gregorian_date TEXT,
        hotel_name TEXT,
        description TEXT,
        bus_number TEXT,
        driver_name TEXT,
        driver_phone TEXT,
        supervisor_name TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT,
        updated_at TEXT
    );
    """)

    # Customers table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL,
        customer_number TEXT NOT NULL,
        card_number TEXT NOT NULL,
        full_name TEXT NOT NULL,
        national_id TEXT,
        phone TEXT NOT NULL,
        pickup_point TEXT NOT NULL,
        seat_number TEXT,
        hotel_name TEXT,
        room_number TEXT,
        ticket_price TEXT DEFAULT '0',
        status TEXT DEFAULT 'مسجل',
        notes TEXT,
        registered_at TEXT,
        created_at TEXT,
        FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE CASCADE
    );
    """)

    # Ensure ticket_price column exists for migrations
    cursor.execute("PRAGMA table_info(customers)")
    existing_cols = [c[1] for c in cursor.fetchall()]
    if "ticket_price" not in existing_cols:
        cursor.execute("ALTER TABLE customers ADD COLUMN ticket_price TEXT DEFAULT '0'")

    conn.commit()

    # Insert default settings if empty
    cursor.execute("SELECT COUNT(*) FROM settings")
    if cursor.fetchone()[0] == 0:
        default_settings = {
            "org_name": "المنفذ المثالي لتنظيم الرحلات السياحية",
            "branch_name": "فرع شقراء والدوادمي",
            "license_number": "73104896",
            "system_title": "نظام كشف العملاء في الرحلات – المرحلة الأولى",
            "manifest_title": "كشف تسجيل العملاء في الرحلة",
            "manifest_subtitle": "المرحلة الأولى - المنفذ المثالي – فرع شقراء والدوادمي",
            "card_footer": "جميع حساباتنا - في مكان واحد",
            "supervisor_name": "مشرف الرحلات",
            "supervisor_phone": "0555123456",
            "whatsapp_template": "السلام عليكم ورحمة الله وبركاته، معك مشرف رحلة [{trip_name}] من المنفذ المثالي. نود الاطمئنان عليكم والتأكيد على موعد وتفاصيل انطلاق الرحلة من نقطة {pickup_point}. نرجو منكم تأكيد الحضور والتواصل معنا شاكرين لكم.",
            "theme_color": "#00a8a8",
            "accent_color": "#0f4c81"
        }
        for k, v in default_settings.items():
            cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, v))
        conn.commit()

    # Insert default users if empty
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] == 0:
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        users = [
            ("admin", "123456", "المشرف العام - المنفذ المثالي", "admin", "الفرع الرئيسي"),
            ("shaqra", "123456", "مشرف فرع شقراء", "supervisor", "شقراء"),
            ("dawadmi", "123456", "مشرف فرع الدوادمي", "supervisor", "الدوادمي"),
        ]
        for u in users:
            cursor.execute(
                "INSERT INTO users (username, password, full_name, role, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (u[0], u[1], u[2], u[3], u[4], now_str)
            )
        conn.commit()

    # Check if trips exist, if not populate seed data
    cursor.execute("SELECT COUNT(*) FROM trips")
    if cursor.fetchone()[0] == 0:
        seed_data(conn)

    conn.close()

def seed_data(conn):
    cursor = conn.cursor()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    trips_seed = [
        {
            "name": "رحلة 21 محرم 1448هـ",
            "hijri_date": "21 محرم 1448هـ",
            "gregorian_date": "2026-07-06",
            "hotel_name": "فندق أبراج مكة ميلينيوم",
            "description": "رحلة سياحية متكاملة شاملة الإقامة والمواصلات والوجبات",
            "bus_number": "حافلة VIP 1 (مرسيدس 2025)",
            "driver_name": "سعد بن ناصر الدوسري",
            "driver_phone": "0551239874",
            "supervisor_name": "عبدالرحمن بن خالد المقرن",
            "status": "active",
            "shaqra_count": 32,
            "dawadmi_count": 26,
            "code_prefix": "TRIP-1448-01"
        },
        {
            "name": "رحلة 10 صفر 1448هـ",
            "hijri_date": "10 صفر 1448هـ",
            "gregorian_date": "2026-07-25",
            "hotel_name": "فندق أنوار المدينة موفنبيك",
            "description": "زيارة المدينة المنورة والإقامة بجوار الحرم النبوي الشريف",
            "bus_number": "حافلة VIP 2 (مان 2025)",
            "driver_name": "فهد بن عبدالله الحربي",
            "driver_phone": "0509876541",
            "supervisor_name": "محمد بن إبراهيم الحميضي",
            "status": "active",
            "shaqra_count": 28,
            "dawadmi_count": 24,
            "code_prefix": "TRIP-1448-02"
        },
        {
            "name": "رحلة 25 صفر 1448هـ",
            "hijri_date": "25 صفر 1448هـ",
            "gregorian_date": "2026-08-09",
            "hotel_name": "فندق سويس أوتيل مكة (برج الساعة)",
            "description": "رحلة متميزة مع إطلالة مباشرة على الكعبة المشرفة",
            "bus_number": "حافلة VIP 3",
            "driver_name": "تركي بن مطلق العتيبي",
            "driver_phone": "0533344556",
            "supervisor_name": "عبدالله بن فهد الشعلان",
            "status": "active",
            "shaqra_count": 29,
            "dawadmi_count": 23,
            "code_prefix": "TRIP-1448-03"
        },
        {
            "name": "رحلة 12 ربيع الأول 1448هـ",
            "hijri_date": "12 ربيع الأول 1448هـ",
            "gregorian_date": "2026-08-25",
            "hotel_name": "فندق دار التوحيد إنتركونتيننتال",
            "description": "رحلة روحانية فاخرة في ساحة الحرم المكي",
            "bus_number": "حافلة VIP 4",
            "driver_name": "سلطان بن محمد القحطاني",
            "driver_phone": "0544455667",
            "supervisor_name": "إبراهيم بن صالح السياري",
            "status": "active",
            "shaqra_count": 26,
            "dawadmi_count": 22,
            "code_prefix": "TRIP-1448-04"
        },
        {
            "name": "رحلة 28 ربيع الأول 1448هـ",
            "hijri_date": "28 ربيع الأول 1448هـ",
            "gregorian_date": "2026-09-10",
            "hotel_name": "فندق هيلتون المؤتمرات جبل عمر",
            "description": "رحلة إجازة نهاية الأسبوع لخدمة أهالي شقراء والدوادمي",
            "bus_number": "حافلة VIP 5",
            "driver_name": "منصور بن راشد الغامدي",
            "driver_phone": "0566677889",
            "supervisor_name": "خالد بن عبدالعزيز العبداللطيف",
            "status": "active",
            "shaqra_count": 27,
            "dawadmi_count": 25,
            "code_prefix": "TRIP-1448-05"
        }
    ]

    first_names_m = [
        "أحمد", "محمد", "عبدالله", "عبدالرحمن", "فهد", "خالد", "سلطان", "تركي", 
        "سعود", "فيصل", "سعد", "إبراهيم", "صالح", "ناصر", "علي", "عبدالعزيز",
        "عمر", "ماجد", "منصور", "بندر", "نايف", "راشد", "سليمان", "مشاري", "حمد"
    ]
    
    first_names_f = [
        "نورة", "سارة", "هيا", "موضي", "لطيفة", "حصة", "منيرة", "منى", "فاطمة",
        "ريم", "العنود", "هند", "أمل", "منى", "خلود", "شهد", "مها", "عبير", "نوف"
    ]

    middle_names = [
        "بن عبدالله", "بن محمد", "بن فهد", "بن خالد", "بن سعد", "بن ناصر", 
        "بن إبراهيم", "بن صالح", "بن عبدالعزيز", "بن سليمان", "بن علي", "بن منصور"
    ]

    family_names_shaqra = [
        "العتيبي", "المقرن", "الحميضي", "الشعلان", "السياري", "العبداللطيف", "البواردي",
        "الجميح", "الخراشي", "الهدلق", "اليوسف", "المنيع", "الرديني", "الصالح", "الرويس"
    ]

    family_names_dawadmi = [
        "العتيبي", "النفيعي", "الروقي", "المقاطي", "العصيمي", "الشيباني", "الهذلي",
        "القحطاني", "الدوسري", "الحربي", "الغربي", "الرويس", "المهيدب", "السبيل", "الضويان"
    ]

    phone_prefixes = ["050", "053", "055", "054", "056", "058", "059"]

    cust_global_counter = 1

    for trip_idx, trip in enumerate(trips_seed):
        cursor.execute("""
            INSERT INTO trips (name, hijri_date, gregorian_date, hotel_name, description, bus_number, driver_name, driver_phone, supervisor_name, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            trip["name"], trip["hijri_date"], trip["gregorian_date"], trip["hotel_name"],
            trip["description"], trip["bus_number"], trip["driver_name"], trip["driver_phone"],
            trip["supervisor_name"], trip["status"], now_str, now_str
        ))
        trip_id = cursor.lastrowid

        seat_num = 1
        
        # 1. Generate Shaqra passengers
        for i in range(trip["shaqra_count"]):
            is_female = random.random() < 0.35
            fn = random.choice(first_names_f) if is_female else random.choice(first_names_m)
            mn = random.choice(middle_names)
            ln = random.choice(family_names_shaqra)
            full_name = f"{fn} {mn} {ln}"
            
            nat_id = f"10{random.randint(10000000, 99999999)}"
            phone = f"{random.choice(phone_prefixes)}{random.randint(1000000, 9999999)}"
            card_num = f"{trip['code_prefix']}-SHQ-{cust_global_counter:04d}"
            cust_num = f"CUST-{cust_global_counter:04d}"
            room_num = f"{random.randint(2, 14)}{random.randint(10, 45)}"

            rand_val = random.random()
            if rand_val < 0.72:
                status = "مؤكد"
                notes = "تم تأكيد الحجز وجاهزية المقعد"
            elif rand_val < 0.85:
                status = "مسجل"
                notes = "بانتظار التأكيد النهائي للرحلة"
            elif rand_val < 0.95:
                status = "عدم الحضور"
                notes = "لم يحضر في نقطة التجمع بشقراء - يلزم الاتصال أو مراسلته واتساب فوراً"
            else:
                status = "ملغي"
                notes = "تم الإلغاء بطلب من العميل"

            cursor.execute("""
                INSERT INTO customers (trip_id, customer_number, card_number, full_name, national_id, phone, pickup_point, seat_number, hotel_name, room_number, ticket_price, status, notes, registered_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                trip_id, cust_num, card_num, full_name, nat_id, phone, "شقراء",
                str(seat_num), trip["hotel_name"], room_num, "150", status, notes, trip["hijri_date"], now_str
            ))
            seat_num += 1
            cust_global_counter += 1

        # 2. Generate Dawadmi passengers
        for i in range(trip["dawadmi_count"]):
            is_female = random.random() < 0.35
            fn = random.choice(first_names_f) if is_female else random.choice(first_names_m)
            mn = random.choice(middle_names)
            ln = random.choice(family_names_dawadmi)
            full_name = f"{fn} {mn} {ln}"
            
            nat_id = f"10{random.randint(10000000, 99999999)}"
            phone = f"{random.choice(phone_prefixes)}{random.randint(1000000, 9999999)}"
            card_num = f"{trip['code_prefix']}-DAW-{cust_global_counter:04d}"
            cust_num = f"CUST-{cust_global_counter:04d}"
            room_num = f"{random.randint(2, 14)}{random.randint(10, 45)}"

            rand_val = random.random()
            if rand_val < 0.72:
                status = "مؤكد"
                notes = "تم تأكيد الحجز وجاهزية المقعد"
            elif rand_val < 0.85:
                status = "مسجل"
                notes = "بانتظار التأكيد النهائي للرحلة"
            elif rand_val < 0.95:
                status = "عدم الحضور"
                notes = "لم يحضر في نقطة التجمع بالدوادمي - يلزم الاتصال أو مراسلته واتساب فوراً"
            else:
                status = "ملغي"
                notes = "تم الإلغاء بطلب من العميل"

            cursor.execute("""
                INSERT INTO customers (trip_id, customer_number, card_number, full_name, national_id, phone, pickup_point, seat_number, hotel_name, room_number, ticket_price, status, notes, registered_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                trip_id, cust_num, card_num, full_name, nat_id, phone, "الدوادمي",
                str(seat_num), trip["hotel_name"], room_num, "150", status, notes, trip["hijri_date"], now_str
            ))
            seat_num += 1
            cust_global_counter += 1

    conn.commit()

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully with sample trips and passengers.")
