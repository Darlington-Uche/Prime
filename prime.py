import requests
import time
import subprocess
import random
import datetime
import json
import os

# ==================
# CONFIG
# ==================
LOGIN_URL = "https://api.primevideo.pw/api/user/login?lang=eng"
TASK_URL = "https://api.primevideo.pw/api/task/task_info?d=1755184676245"

ACCOUNT = "Primeboy@gmail.com"
PWD_CODE = "eefe494c01f5f27954ee1b72ff5ad511"

CHECK_INTERVAL = 60             # seconds between checks
NOTIFY_TIMES = 5                 # times to notify when unlocked
MAX_RETRIES = 3                  # retries for each request
LOG_FILE = "vip1_checker.log"    # saves server responses

USER_AGENTS = [
    "Mozilla/5.0 (Linux; Android 13; Pixel 6 Pro) AppleWebKit/537.36 Chrome/114.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 12; SM-G996B) AppleWebKit/537.36 Chrome/110.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 11; Redmi Note 10) AppleWebKit/537.36 Chrome/108.0.0.0 Mobile Safari/537.36"
]

# ==================
# UTILS
# ==================
def log(msg, save=False):
    timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] {msg}"
    print(line)
    if save:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")

def send_notification(msg):
    subprocess.run(["termux-notification", "--title", "VIP1 Checker", "--content", msg])
    subprocess.run(["termux-vibrate", "-d", "500"])
    subprocess.run(["termux-toast", msg])

def save_response(tag, res):
    """Save server response in JSON format for debugging"""
    try:
        data = res.json()
    except:
        data = res.text
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n--- {tag} RESPONSE [{datetime.datetime.now()}] ---\n")
        f.write(json.dumps(data, indent=2, ensure_ascii=False) if isinstance(data, dict) else str(data))
        f.write("\n------------------------------------\n")

# ==================
# CORE FUNCTIONS
# ==================
def get_token():
    for attempt in range(MAX_RETRIES):
        try:
            payload = {"account": ACCOUNT, "code": "", "pwd": PWD_CODE}
            headers = {"User-Agent": random.choice(USER_AGENTS)}
            res = requests.post(LOGIN_URL, json=payload, headers=headers, timeout=10)
            
            log(f"📥 Login response status: {res.status_code}")
            save_response("LOGIN", res)
            
            res.raise_for_status()
            token = res.json()["data"]["token"]
            log(f"🔑 Got token: {token[:15]}...")
            return token
        except Exception as e:
            log(f"❌ Login failed (attempt {attempt+1}): {e}", save=True)
            send_notification(f"❌ Login failed: {e}")
            time.sleep(3)
    return None

def check_vip1(token):
    for attempt in range(MAX_RETRIES):
        try:
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/plain, */*",
                "User-Agent": random.choice(USER_AGENTS)
            }
            res = requests.get(TASK_URL, headers=headers, timeout=10)
            
            log(f"📥 VIP1 response status: {res.status_code}")
            save_response("VIP1", res)
            
            res.raise_for_status()
            data = res.json()
            for level in data.get("data", {}).get("level_list", []):
                if level.get("name") == "VIP1":
                    return level.get("is_unlock", 0)
        except Exception as e:
            log(f"❌ Error checking VIP1 (attempt {attempt+1}): {e}", save=True)
            send_notification(f"❌ VIP1 check error: {e}")
            time.sleep(2)
    return 0

# ==================
# MAIN
# ==================
if __name__ == "__main__":
    subprocess.run(["termux-wake-lock"])  # Prevent sleep
    log("🚀 VIP1 Auto-Checker Started...", save=True)

    token = get_token()
    if not token:
        log("❌ Could not get token. Exiting.", save=True)
        subprocess.run(["termux-wake-unlock"])
        exit()

    try:
        while True:
            status = check_vip1(token)

            if status == 1:
                log("✅ VIP1 is UNLOCKED!", save=True)
                for _ in range(NOTIFY_TIMES):
                    send_notification("🚀 VIP1 is now unlocked!")
                    time.sleep(2)
            else:
                log("❌ VIP1 still locked.", save=True)

            time.sleep(CHECK_INTERVAL)

    except KeyboardInterrupt:
        log("🛑 Stopped by user.", save=True)
    except Exception as e:
        log(f"💥 Fatal error: {e}", save=True)
        send_notification(f"💥 Script crashed: {e}")
    finally:
        subprocess.run(["termux-wake-unlock"])
        log("🔓 Wakelock released.", save=True)