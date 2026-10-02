import json,urllib.request,concurrent.futures as cf
def get(u):
    for i in range(3):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'Mozilla/5.0'}),timeout=20))
        except Exception as ex: err=ex
    return None
ev=get("https://gamma-api.polymarket.com/events?tag_id=84&closed=false&limit=80&order=volume24hr&ascending=false")
jobs=[]
for e in ev:
    if 'temperature' not in e['title'].lower(): continue
    for m in e.get('markets',[]):
        if m.get('closed'): continue
        tok=json.loads(m.get('clobTokenIds') or '[]')
        if not tok: continue
        jobs.append(dict(ev=e['slug'],mid=float(json.loads(m['outcomePrices'])[0]),bid=m.get('bestBid'),ask=m.get('bestAsk'),vol=float(m.get('volume') or 0),v24=float(m.get('volume24hr') or 0),tok=tok[0]))
print(len(jobs))
with cf.ThreadPoolExecutor(16) as ex:
    for j,b in zip(jobs,ex.map(lambda j:get(f"https://clob.polymarket.com/book?token_id={j['tok']}"),jobs)):
        j['asks']=[(float(a['price']),float(a['size'])) for a in (b or {}).get('asks',[])]
        j['bids']=[(float(a['price']),float(a['size'])) for a in (b or {}).get('bids',[])]
json.dump(jobs,open('bt_books_now.json','w'))
