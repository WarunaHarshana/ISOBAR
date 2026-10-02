import json,math,sys,collections
d=json.load(open(sys.argv[1]))
R=[r for r in d['evalRows'] if r['allPx'] and r['members']>=8]
def norm(v):
    s=sum(v); return [x/s for x in v] if s>0 else None
def sc(q,w): return sum((q[i]-(i==w))**2 for i in range(len(q))), -math.log(max(q[w],1e-3))
for P in ['D-1 18:00','D 09:00','D 13:00','D 16:00']:
    recs=[]
    for r in R:
        if r['point']!=P: continue
        m=norm([b['mp'] for b in r['b']]); k=norm([b['px'] for b in r['b']]); s=sum(b['px'] for b in r['b'])
        if not m or not k or s<0.5 or s>1.6: continue
        recs.append((r['date'],m,k,[b['won'] for b in r['b']].index(True)))
    def fit(rs):
        best=None
        for wi in range(21):
            w=wi/20; ll=sum(sc([w*a+(1-w)*b for a,b in zip(m,k)],win)[1] for _,m,k,win in rs)
            if best is None or ll<best[1]: best=(w,ll)
        return best[0]
    dates=sorted({x[0] for x in recs}); oos=[];ws=[]
    for D in dates:
        w=fit([x for x in recs if x[0]!=D]); ws.append(w)
        for _,m,k,win in [x for x in recs if x[0]==D]:
            oos.append((sc([w*a+(1-w)*b for a,b in zip(m,k)],win),sc(k,win),sc(m,win)))
    n=len(oos); wall=fit(recs)
    print(f"{P:10s} n{n} w_full {wall:.2f} w_cv range {min(ws):.2f}-{max(ws):.2f} | OOS Brier blend {sum(o[0][0] for o in oos)/n:.4f} mkt {sum(o[1][0] for o in oos)/n:.4f} model {sum(o[2][0] for o in oos)/n:.4f} | OOS logloss blend {sum(o[0][1] for o in oos)/n:.4f} mkt {sum(o[1][1] for o in oos)/n:.4f}")
