import requests
import time
import subprocess
import random
from datetime import datetime

# ==================
# CONFIG
# ==================
LOGIN_URL = "https://api.primevideo.pw/api/user/login?lang=eng"
TASK_ID_LIST = [
    "1755184676245",
    "1755184676246",
    "1755184676247",
    "1755184676248"
]  # Rotates between these IDs

ACCOUNTS = [
    {"email": "Kb1@gmail.com", "pwd": "e6b44d01d80833b117fc61d09457b689"},
    # Add more accounts here if available
]

CHECK_INTERVAL_RANGE = (45, 90)  # Wider range for more randomness
NOTIFY_TIMES = 5
MAX_RETRIES = 3
SESSION_DURATION = 10 * 60  # Rotate session every 30 minutes
ERROR_NOTIFICATION_COOLDOWN = 300  # 5 minutes between error notifications

# ==================
# GLOBALS
# ==================
last_error_notification = 0

# ==================
# FUNCTIONS
# ==================
USER_AGENTS = [
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 12; SM-A105F) AppleWebKit/537.36 Chrome/117.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/115.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile Safari/604.1"
]

REFERERS = [
    "https://primevideo.pw/",
    "https://primevideo.pw/home",
    "https://primevideo.pw/vip",
    "https://primevideo.pw/tasks"
]

def log(msg, error=False):
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    if error:
        print(f"[{timestamp}] ❌ ERROR: {msg}")
        notify_error(msg)
    else:
        print(f"[{timestamp}] {msg}")

def notify_error(error_msg):
    global last_error_notification
    current_time = time.time()
    if current_time - last_error_notification > ERROR_NOTIFICATION_COOLDOWN:
        try:
            short_msg = f"Error: {error_msg[:50]}..." if len(error_msg) > 50 else f"Error: {error_msg}"
            subprocess.run(["termux-notification", "--title", "SCRIPT ERROR", "--content", short_msg])
            subprocess.run(["termux-vibrate", "-d", "1000"])  # Longer vibration for errors
            subprocess.run(["termux-toast", short_msg])
            last_error_notification = current_time
        except Exception as e:
            print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ❌ Failed to send error notification: {e}")

def send_notification(msg, is_error=False):
    try:
        if is_error:
            subprocess.run(["termux-notification", "--title", "SCRIPT ERROR", "--content", msg])
            subprocess.run(["termux-vibrate", "-d", "1000", "-f"])  # Force vibration for errors
        else:
            subprocess.run(["termux-notification", "--title", "VIP1 Status", "--content", msg])
            subprocess.run(["termux-vibrate", "-d", "500"])
        subprocess.run(["termux-toast", msg])
    except Exception as e:
        log(f"Notification failed: {e}", error=True)

def get_enhanced_headers():
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": random.choice(REFERERS),
        "Origin": "https://primevideo.pw",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
    }

def get_token(account):
    for attempt in range(MAX_RETRIES):
        try:
            payload = {"account": account["email"], "code": "", "pwd": account["pwd"]}
            headers = get_enhanced_headers()
            
            time.sleep(random.uniform(1, 3))
            
            with requests.Session() as session:
                session.headers.update(headers)
                res = session.post(LOGIN_URL, json=payload)
                
            log(f"Login attempt {attempt + 1} status: {res.status_code}")
            
            if res.status_code != 200:
                error_msg = f"Login failed with status {res.status_code}"
                log(error_msg, error=True)
                raise Exception(error_msg)
                
            token = res.json().get("data", {}).get("token")
            if not token:
                error_msg = "No token in response"
                log(error_msg, error=True)
                raise Exception(error_msg)
                
            log(f"Got token: {token[:15]}...")
            return token, res.cookies.get_dict()
            
        except Exception as e:
            error_msg = f"Login attempt {attempt + 1} failed: {str(e)}"
            log(error_msg, error=True)
            
            if attempt < MAX_RETRIES - 1:
                wait_time = random.randint(5, 15)
                log(f"Retrying in {wait_time} seconds...")
                time.sleep(wait_time)
    
    send_notification("⚠️ Failed to login after multiple attempts!", is_error=True)
    return None, None

def check_vip1(session, token):
    task_id = random.choice(TASK_ID_LIST)
    task_url = f"https://api.primevideo.pw/api/task/task_info?d={task_id}"
    
    try:
        time.sleep(random.uniform(0.5, 2.5))
        
        headers = get_enhanced_headers()
        headers["Authorization"] = f"Bearer {token}"
        
        res = session.get(task_url, headers=headers)
        log(f"Checked Task {task_id} → Status: {res.status_code}")
        
        if res.status_code != 200:
            error_msg = f"VIP check failed with status {res.status_code}"
            log(error_msg, error=True)
            return 0
            
        data = res.json()
        if "data" not in data or "level_list" not in data["data"]:
            error_msg = "Unexpected API response format"
            log(error_msg, error=True)
            return 0
            
        for level in data["data"]["level_list"]:
            if level.get("name") == "VIP1":
                return level.get("is_unlock", 0)
                
        error_msg = "VIP1 level not found in response"
        log(error_msg, error=True)
        return 0
            
    except Exception as e:
        error_msg = f"Error checking VIP1: {str(e)}"
        log(error_msg, error=True)
        return 0

def main_loop():
    global last_error_notification
    
    log("🚀 VIP1 Auto-Checker Started...")
    current_account = random.choice(ACCOUNTS)
    token, cookies = get_token(current_account)
    
    if not token:
        send_notification("❌ Critical: Failed to get initial token, exiting!", is_error=True)
        return

    session = requests.Session()
    session.headers.update(get_enhanced_headers())
    if cookies:
        session.cookies.update(cookies)
    
    last_session_rotation = time.time()
    check_counter = 0
    
    while True:
        try:
            if time.time() - last_session_rotation > SESSION_DURATION:
                log("🔄 Rotating session...")
                current_account = random.choice(ACCOUNTS)
                token, cookies = get_token(current_account)
                if token:
                    session = requests.Session()
                    session.headers.update(get_enhanced_headers())
                    if cookies:
                        session.cookies.update(cookies)
                    last_session_rotation = time.time()
                else:
                    log("⚠️ Failed to rotate session", error=True)
                    time.sleep(60)
                    continue
            
            status = check_vip1(session, token)
            check_counter += 1
            
            if status == 1:
                log("✅ VIP1 is UNLOCKED!")
                for _ in range(NOTIFY_TIMES):
                    send_notification("🚀 VIP1 is now unlocked!")
                    time.sleep(2)
                time.sleep(random.randint(300, 600))
            else:
                log("❌ VIP1 still locked.")
            
            base_delay = random.uniform(*CHECK_INTERVAL_RANGE)
            jitter = random.uniform(-15, 15)
            delay = max(30, base_delay + jitter)
            log(f"⏳ Next check in {delay:.1f} seconds")
            time.sleep(delay)
            
            if check_counter % random.randint(5, 10) == 0:
                long_break = random.randint(120, 300)
                log(f"💤 Taking a longer break of {long_break} seconds...")
                time.sleep(long_break)
                
        except KeyboardInterrupt:
            log("🛑 Script stopped by user")
            send_notification("Script stopped manually", is_error=True)
            break
        except Exception as e:
            error_msg = f"Unexpected error in main loop: {str(e)}"
            log(error_msg, error=True)
            time.sleep(60)

if __name__ == "__main__":
    try:
        main_loop()
    except Exception as e:
        error_msg = f"Critical error crashed the script: {str(e)}"
        log(error_msg, error=True)
        send_notification(error_msg, is_error=True)