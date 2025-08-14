import requests
import time
import subprocess

# ==================
# CONFIG
# ==================
LOGIN_URL = "https://api.primevideo.pw/api/user/login?lang=eng"
TASK_URL = "https://api.primevideo.pw/api/task/task_info?d=1755184676245"

ACCOUNT = "Primeboy@gmail.com"   # replace with your Gmail
PWD_CODE = "eefe494c01f5f27954ee1b72ff5ad511"  # paste the pwd value seen in login request payload
CHECK_INTERVAL = 60                  # seconds between checks
NOTIFY_TIMES = 5                   # how many times to notify when unlocked

# ==================
# FUNCTIONS
# ==================
def send_notification(msg):
    subprocess.run(["termux-notification", "--title", "VIP1 Status", "--content", msg])
    subprocess.run(["termux-vibrate", "-d", "500"])
    subprocess.run(["termux-toast", msg])

def get_token():
    try:
        payload = {
            "account": ACCOUNT,
            "code": "",
            "pwd": PWD_CODE
        }
        res = requests.post(LOGIN_URL, json=payload)
        print("📥 Raw response:", res.text)  # debug
        res.raise_for_status()
        token = res.json()["data"]["token"]
        print(f"🔑 Got token: {token[:15]}...")
        return token
    except Exception as e:
        print(f"❌ Login failed: {e}")
        return None

def check_vip1(token):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36"
    }
    try:
        res = requests.get(TASK_URL, headers=headers)
        res.raise_for_status()
        data = res.json()
        for level in data.get("data", {}).get("level_list", []):
            if level.get("name") == "VIP1":
                return level.get("is_unlock", 0)
    except Exception as e:
        print(f"❌ Error checking VIP1: {e}")
    return 0

# ==================
# MAIN LOOP
# ==================
if __name__ == "__main__":
    print("🚀 VIP1 Auto-Checker Started...")
    token = get_token()
    if not token:
        exit()

    while True:
        status = check_vip1(token)
        if status == 1:
            print("✅ VIP1 is UNLOCKED!")
            for _ in range(NOTIFY_TIMES):
                send_notification("🚀 VIP1 is now unlocked!")
                time.sleep(2)
        else:
            print("❌ VIP1 still locked.")
        time.sleep(CHECK_INTERVAL)