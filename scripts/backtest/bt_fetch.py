import json,re,urllib.request,concurrent.futures as cf,datetime as dt
s=json.load(open('snap.now.json'))
pref={}
for e in s['events']:
    m=re.match(r'(highest|lowest)-temperature-in-(.+)-on-[a-z]+-\d+-\d{4}$',e['slug'])
    if m: pref[(m.group(1),e['cityId'])]=m.group(2)
print(len(pref))
def get(u):
    for i in range(3):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'Mozilla/5.0'}),timeout=20))
        except Exception as ex: err=ex
    return None
jobs=[]
for d in range(1,15):
    day=dt.date(2026,10,2)-dt.timedelta(days=d)
    mon=day.strftime('%B').lower()
    for (kind,cid),cs in pref.items():
        jobs.append((kind,cid,day.isoformat(),f"https://gamma-api.polymarket.com/events?slug={kind}-temperature-in-{cs}-on-{mon}-{day.day}-{day.year}"))
out=[]
with cf.ThreadPoolExecutor(12) as ex:
    for (kind,cid,day,u),r in zip(jobs,ex.map(lambda j:get(j[3]),jobs)):
        if r: out.append({'kind':kind,'cityId':cid,'date':day,'event':r[0]})
json.dump(out,open('bt_events.json','w'))
print(len(out))
