"""Fetch non-Yahoo daily OHLCV and compute technical status; fail closed on gaps.
Provider: Stooq daily CSV (availability is not guaranteed for every symbol).
"""
import csv, io, json, os, urllib.request
from datetime import datetime, timezone
from pathlib import Path
from decision_validation import technical, health

ROOT=Path(__file__).resolve().parent
OUTPUT=ROOT/"semiconductor-latest.json"

def fetch_stooq(symbol):
    url="https://stooq.com/q/d/l/?s="+symbol.lower()+".us&i=d"
    request=urllib.request.Request(url,headers={"User-Agent":"Risk29-DataMonitor/1.0"})
    with urllib.request.urlopen(request,timeout=25) as response:
        body=response.read(3000000).decode("utf-8-sig")
    records=list(csv.DictReader(io.StringIO(body)))
    if not records or not {"Date","Close","Volume"}.issubset(records[0]): raise ValueError("provider unavailable or invalid CSV")
    path=ROOT/("_"+symbol.lower()+"_prices.csv")
    with path.open("w",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=["date","close","volume"])
        writer.writeheader()
        for row in records: writer.writerow({"date":row["Date"],"close":row["Close"],"volume":row["Volume"]})
    try: return technical(path,symbol)
    finally: path.unlink(missing_ok=True)

def run():
    now=datetime.now(timezone.utc)
    result={"generatedAt":now.isoformat(),"provider":"Stooq","providerType":"daily historical OHLCV","symbols":{},"overall":"TECHNICAL DATA GAP"}
    for symbol in ("SMH","SOXX"):
        try:
            value=fetch_stooq(symbol)
            # Reject stale data even if historical session count is sufficient.
            if value.get("cutoff"):
                from datetime import date
                days=(now.date()-date.fromisoformat(value["cutoff"])).days
                if days>5 or days<0:
                    value={"symbol":symbol,"status":"TECHNICAL DATA GAP","reason":"last available session outside 5 calendar days","cutoff":value["cutoff"]}
            result["symbols"][symbol]=value
        except Exception as e:
            result["symbols"][symbol]={"status":"TECHNICAL DATA GAP","reason":str(e)[:180]}
    if all(v.get("sessions",0)>=220 for v in result["symbols"].values()):
        result["overall"]="CALCULATED — breadth and leaders not independently verified"
    OUTPUT.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
    print(json.dumps(result,ensure_ascii=False))
    return result

if __name__=="__main__": run()
