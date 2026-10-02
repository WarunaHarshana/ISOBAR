import json,urllib.request,time,concurrent.futures as cf
rows=json.load(open('bt_rows.json'))
jobs=[(b,r['t0']) for r in rows for b in r['buckets']]
def hist(j):
    b,t0=j
    for i in range(6):
        try:
            r=json.load(urllib.request.urlopen(urllib.request.Request(f"https://clob.polymarket.com/prices-history?market={b['tok']}&startTs={t0}&endTs={t0+2*86400}&fidelity=5",headers={'user-agent':'Mozilla/5.0'}),timeout=30))
            return r.get('history',[])
        except Exception: time.sleep(2+3*i)
    return None
miss=0
with cf.ThreadPoolExecutor(8) as ex:
    for (b,t0),h in zip(jobs,ex.map(hist,jobs)):
        if h: b['hist']=h
        else: miss+=1
json.dump(rows,open('bt_rows5.json','w'))
print('jobs',len(jobs),'missing(kept 30m)',miss)
