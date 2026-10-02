import json,datetime as dt
from zoneinfo import ZoneInfo
rows=json.load(open('bt_rows.json')); cities=json.load(open('bt_cities.json'))
LAT=7  # hours after init until usable (observed publish ~6-7h)
POINTS={'D-1 18':(-1,18),'D 09':(0,9),'D 13':(0,13),'D 16':(0,16)}
def init_for(t):
    u=t-dt.timedelta(hours=LAT); h=0 if u.hour<12 else 12
    return dt.datetime(u.year,u.month,u.day,h,tzinfo=dt.timezone.utc)
need={}
for r in rows:
    tz=ZoneInfo(cities[r['cityId']]['tz']); d=dt.date.fromisoformat(r['date'])
    for k,(dd,hh) in POINTS.items():
        dd_=d+dt.timedelta(days=dd); t=dt.datetime(dd_.year,dd_.month,dd_.day,hh,tzinfo=tz).astimezone(dt.timezone.utc)
        i=init_for(t); need.setdefault(i.isoformat(),set()).add(r['cityId'])
tot=sum(len(v) for v in need.values())
for k in sorted(need): print(k,len(need[k]))
print('inits',len(need),'city-inits',tot,'est GiB',tot*196/1024)
json.dump({k:sorted(v) for k,v in need.items()},open('bt_need.json','w'))
