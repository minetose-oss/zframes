"""Risk29 data health and semiconductor technical validation. No Yahoo Finance."""
import csv, json, math, sys
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean

def timestamp(s):
    return datetime.fromisoformat(s.replace("Z","+00:00")).astimezone(timezone.utc)

def health(brief, latest, now=None):
    now = now or datetime.now(timezone.utc)
    out = {"sourceUsed":"risk29-live-data","warnings":[]}
    try:
        btime=timestamp(brief["generatedAt"]); ltime=timestamp(latest["generatedAt"])
        age=(now-btime).total_seconds()
        signals=latest["signals"]
        if not isinstance(signals,list) or not signals: raise ValueError("signals absent")
        out.update(generatedAt=brief["generatedAt"],payloadAgeSeconds=round(age),
                   freshnessPass=0<=age<=86400,confidence=brief.get("confidence","unknown"),
                   totalSignals=len(signals))
        counts={k:sum(s.get("freshness")==k for s in signals) for k in ("fresh","delayed","stale","missing","unavailable","error")}
        out.update(counts)
        bad=[s for s in signals if s.get("freshness") in ("stale","missing","unavailable","error")]
        out["problemSignals"]=[{k:s.get(k) for k in ("id","category","asOf","ageSeconds","reason","freshness")} for s in bad]
        usable=sum(s.get("freshness") in ("fresh","delayed") for s in signals)
        out["usableCoveragePct"]=round(100*usable/len(signals),2)
        if not out["freshnessPass"]:out["warnings"].append("DATA HEALTH WARNING: payload outside 24h")
        if abs((btime-ltime).total_seconds())>1 or brief.get("score")!=latest.get("score") or brief.get("state")!=latest.get("state"):
            out["warnings"].append("CONSISTENCY WARNING: brief/latest mismatch")
        if bad:out["warnings"].append("DEGRADED: stale/missing/error signals; never interpret as zero risk")
        if not isinstance(brief.get("dataHealth"),dict):
            out["warnings"].append("brief.dataHealth unavailable; computed from latest.json")
        return out
    except (KeyError,TypeError,ValueError) as e:
        return {"freshnessPass":False,"warnings":["DATA HEALTH WARNING: invalid schema: "+str(e)]}

def ema(values,n):
    if len(values)<n: raise ValueError("insufficient EMA history")
    a=2/(n+1); result=mean(values[:n])
    for v in values[n:]: result=a*v+(1-a)*result
    return result

def technical(csv_path, symbol):
    rows=list(csv.DictReader(open(csv_path,newline="",encoding="utf-8")))
    clean=[]
    for r in rows:
        try:
            d=r["date"]; close=float(r["close"]); volume=float(r["volume"])
            if not math.isfinite(close) or close<=0 or not math.isfinite(volume) or volume<0:continue
            clean.append((d,close,volume))
        except (KeyError,ValueError,TypeError):continue
    clean.sort(key=lambda x:x[0])
    clean=list({x[0]:x for x in clean}.values())
    if len(clean)<220:
        return {"symbol":symbol,"status":"TECHNICAL DATA GAP","availableSessions":len(clean),"requiredSessions":220}
    dates,closes,volumes=zip(*clean)
    if any(v<=0 for v in volumes[-20:]):
        return {"symbol":symbol,"status":"TECHNICAL DATA GAP","reason":"invalid or zero volume in last 20 sessions"}
    e={n:ema(closes,n) for n in (20,50,200)}
    vol20=mean(volumes[-20:]); ratio=volumes[-1]/vol20
    above20=closes[-1]>e[20]; above50=closes[-1]>e[50]; above200=closes[-1]>e[200]
    swing_low=min(closes[-60:-1]); new_low=closes[-1]<swing_low
    if (not above200 or new_low) and ratio>1: state="BREAKDOWN"
    elif not above20:state="NOT CONFIRMED"
    elif not above50:state="EARLY RECOVERY"
    else:state="PENDING BREADTH/LEADER CONFIRMATION" if ratio>=1 else "EARLY RECOVERY"
    return {"symbol":symbol,"cutoff":dates[-1],"sessions":len(clean),"close":closes[-1],
            "ema":{str(n):round(e[n],5) for n in e},
            "closeVsEmaPct":{str(n):round(100*(closes[-1]/e[n]-1),3) for n in e},
            "volume20":round(vol20,2),"volumeRatio":round(ratio,3),
            "drawdown60dPct":round(100*(closes[-1]/max(closes[-60:])-1),3),
            "rebound60dPct":round(100*(closes[-1]/min(closes[-60:])-1),3),
            "state":state,"action":"Reduce" if state=="BREAKDOWN" else "Wait" if state.startswith("PENDING") or state=="NOT CONFIRMED" else "Hold",
            "note":"RECOVERY CONFIRMED requires independently verified breadth and leaders; no automatic confirmation"}
if __name__=="__main__":
    if len(sys.argv)>=4 and sys.argv[1]=="technical":
        print(json.dumps(technical(sys.argv[2],sys.argv[3]),indent=2))
    elif len(sys.argv)>=4 and sys.argv[1]=="health":
        print(json.dumps(health(json.load(open(sys.argv[2])),json.load(open(sys.argv[3]))),indent=2))
    else:
        print("Usage: python risk29/decision_validation.py health brief-th.json latest.json | technical prices.csv SMH")
