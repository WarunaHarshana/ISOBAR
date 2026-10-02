import json,re,urllib.request,concurrent.futures as cf,datetime as dt
from zoneinfo import ZoneInfo
ev=json.load(open('bt_events.json'))
# city tz/lat/lon from cities.ts
src=open('/workspace/ISOBAR/src/lib/desk/cities.ts').read()
cities={}
for m in re.finditer(r'\{ id: "([^"]+)".*?lat: ([-\d.]+), lon: ([-\d.]+), tz: "([^"]+)", icao: "([^"]*)"',src):
    cities[m.group(1)]=dict(lat=float(m.group(2)),lon=float(m.group(3)),tz=m.group(4),icao=m.group(5))
json.dump(cities,open('bt_cities.json','w'))
def parse_bound(t,floor_rule):
    t=t.replace('º','°')
    m=re.match(r'(-?\d+)-(-?\d+)°([CF])',t)
    w=0 if floor_rule else 0.5
    if m: a,b=int(m.group(1)),int(m.group(2)); return (a-w,b+1-w if floor_rule else b+w,m.group(3))
    m=re.match(r'(-?\d+)°([CF]) or (below|lower)',t)
    if m: n=int(m.group(1)); return (-1e9,(n+1) if floor_rule else n+.5,m.group(2))
    m=re.match(r'(-?\d+)°([CF]) or (higher|above)',t)
    if m: n=int(m.group(1)); return ((n) if floor_rule else n-.5,1e9,m.group(2))
    m=re.match(r'(-?\d+)°([CF])',t)
    if m: n=int(m.group(1)); return ((n,n+1) if floor_rule else (n-.5,n+.5))+(m.group(2),)
    return None
def get(u):
    for i in range(3):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'Mozilla/5.0'}),timeout=25))
        except Exception: pass
    return None
rows=[];jobs=[]
for e in ev:
    E=e['event']; c=cities.get(e['cityId'])
    if not c: continue
    floor_rule='one decimal place' in (E.get('description') or '')
    tz=ZoneInfo(c['tz']); d=dt.date.fromisoformat(e['date'])
    t0=int(dt.datetime(d.year,d.month,d.day,tzinfo=tz).timestamp())-86400
    bks=[]
    for m in E.get('markets',[]):
        b=parse_bound(m.get('groupItemTitle') or '',floor_rule)
        op=json.loads(m.get('outcomePrices') or '[]'); tok=json.loads(m.get('clobTokenIds') or '[]')
        if not b or not op or not tok: continue
        won= float(op[0])>=0.99; lost=float(op[0])<=0.01
        if not (won or lost): continue
        bks.append(dict(lo=b[0],hi=b[1],unit=b[2],won=won,tok=tok[0],label=m.get('groupItemTitle')))
    if len(bks)<3 or sum(b['won'] for b in bks)!=1: continue
    rows.append(dict(kind=e['kind'],cityId=e['cityId'],date=e['date'],t0=t0,floor=floor_rule,buckets=bks))
    for b in bks: jobs.append((b,t0))
print(len(rows),len(jobs))
def hist(j):
    b,t0=j
    r=get(f"https://clob.polymarket.com/prices-history?market={b['tok']}&startTs={t0}&endTs={t0+2*86400}&fidelity=30")
    return r.get('history',[]) if r else None
with cf.ThreadPoolExecutor(24) as ex:
    for (b,t0),h in zip(jobs,ex.map(hist,jobs)): b['hist']=h
json.dump(rows,open('bt_rows.json','w'))
print('missing hist',sum(1 for b,_ in jobs if not b.get('hist')))
