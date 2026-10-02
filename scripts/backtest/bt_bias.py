import json,collections,statistics as st,math
d=json.load(open('sim_current.json'))
def settled(r):
    w=[b for b in r['b'] if b['won']][0]
    if not (math.isfinite(w['lo']) if isinstance(w['lo'],float) else w['lo'] is not None) : return None
    lo,hi=w['lo'],w['hi']
    if lo is None or hi is None: return None
    try:
        if abs(lo)>1e6 or abs(hi)>1e6: return None
    except: return None
    mid=(lo+hi)/2
    return (mid-32)/1.8 if r['unit']=='F' else mid
err=collections.defaultdict(lambda: collections.defaultdict(list))
allerr=collections.defaultdict(list)
for r in d['evalRows']:
    if r['kind']!='high' or r['meanC'] is None or r['members']<8: continue
    s=settled(r)
    if s is None: continue
    e=r['meanC']-s
    err[r['point']][r['cityId']].append(e); allerr[r['point']].append(e)
for P in ['D-1 18:00','D 09:00']:
    a=allerr[P]; print(P,'n',len(a),'mean bias %.2f sd %.2f MAE %.2f'%(st.mean(a),st.stdev(a),st.mean(abs(x) for x in a)))
# per city using D 09:00 (latest pre-day init), plus EB shrink
P='D 09:00'
rows=[]
for c,v in err[P].items():
    if len(v)<3: continue
    rows.append((c,len(v),st.mean(v),st.stdev(v)))
se2=[s*s/n for c,n,m,s in rows]
tau2=max(0.0,st.pvariance([m for c,n,m,s in rows])-st.mean(se2))
print('tau^2 %.3f tau %.2f'%(tau2,math.sqrt(tau2)))
out={}
for c,n,m,s in sorted(rows,key=lambda x:x[2]):
    k=tau2/(tau2+s*s/n) if tau2>0 else 0
    out[c]=dict(n=n,biasC=round(m,3),sdC=round(s,3),shrink=round(k,3),correctionC=round(k*m,3))
    print(f"{c:15s} n{n:3d} bias {m:+.2f} sd {s:.2f} k {k:.2f} -> {k*m:+.2f}")
json.dump(dict(point=P,tau2=tau2,cities=out,d1={c:(len(v),st.mean(v)) for c,v in err['D-1 18:00'].items()}),open('bt_bias_out.json','w'),indent=1)
