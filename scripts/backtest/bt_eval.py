import json,math,random,collections,statistics as st,sys
d=json.load(open(sys.argv[1] if len(sys.argv)>1 else 'sim_current.json'))
R=[r for r in d['evalRows'] if r['allPx'] and r['members']>=8]
pts=['D-1 18:00','D 09:00','D 13:00','D 16:00']
def norm(v):
    s=sum(v); return [x/s for x in v] if s>0 else None
def score(q,w):
    return sum((q[i]-(i==w))**2 for i in range(len(q))), -math.log(max(q[w],1e-3))
out={}
for P in pts:
    rows=[r for r in R if r['point']==P]
    recs=[]
    for r in rows:
        m=norm([b['mp'] for b in r['b']]); k=norm([b['px'] for b in r['b']])
        s=sum(b['px'] for b in r['b'])
        if not m or not k or s<0.5 or s>1.6: continue
        w=[b['won'] for b in r['b']].index(True)
        recs.append((m,k,w,r))
    n=len(recs)
    if not n: continue
    bm=[score(m,w) for m,k,w,r in recs]; bk=[score(k,w) for m,k,w,r in recs]
    # bootstrap brier diff
    diffs=[a[0]-b[0] for a,b in zip(bm,bk)]
    boot=sorted(sum(random.choice(diffs) for _ in diffs)/n for _ in range(2000))
    best=None; grid=[]
    for wi in range(0,21):
        w=wi/20; ll=0; br=0
        for m,k,win,r in recs:
            q=[w*a+(1-w)*b for a,b in zip(m,k)]; b_,l_=score(q,win); br+=b_; ll+=l_
        grid.append((w,br/n,ll/n))
    bestll=min(grid,key=lambda x:x[2]); bestbr=min(grid,key=lambda x:x[1])
    fav_m=sum(max(range(len(m)),key=lambda i:m[i])==w for m,k,w,r in recs)/n
    fav_k=sum(max(range(len(k)),key=lambda i:k[i])==w for m,k,w,r in recs)/n
    out[P]=dict(n=n,brier_model=sum(x[0] for x in bm)/n,brier_mkt=sum(x[0] for x in bk)/n,ll_model=sum(x[1] for x in bm)/n,ll_mkt=sum(x[1] for x in bk)/n,
        brier_diff_ci=(boot[50],boot[1950]),w_ll=bestll,w_brier=bestbr,top_model=fav_m,top_mkt=fav_k)
    print(f"{P:10s} n {n:4d} Brier model {out[P]['brier_model']:.3f} mkt {out[P]['brier_mkt']:.3f} (diff 95% CI {boot[50]:+.3f}..{boot[1950]:+.3f}) | logloss model {out[P]['ll_model']:.3f} mkt {out[P]['ll_mkt']:.3f} | top-bucket hit model {fav_m:.1%} mkt {fav_k:.1%} | best w (logloss) {bestll[0]:.2f} -> {bestll[2]:.3f}, (brier) {bestbr[0]:.2f} -> {bestbr[1]:.3f}")
    # calibration (model, per bucket)
    cal=collections.defaultdict(lambda:[0,0,0.0]); calk=collections.defaultdict(lambda:[0,0,0.0])
    for m,k,w,r in recs:
        for i,(a,b) in enumerate(zip(m,k)):
            for c,p in ((cal,a),(calk,b)):
                key=0 if p<0.05 else 1 if p<0.15 else 2 if p<0.3 else 3 if p<0.5 else 4 if p<0.7 else 5
                c[key][0]+=1; c[key][1]+=(i==w); c[key][2]+=p
    lab=['<5%','5-15%','15-30%','30-50%','50-70%','>=70%']
    out[P]['cal_model']={lab[k]:(v[0],v[2]/v[0],v[1]/v[0]) for k,v in sorted(cal.items())}
    out[P]['cal_mkt']={lab[k]:(v[0],v[2]/v[0],v[1]/v[0]) for k,v in sorted(calk.items())}
    print('   calib model:', '  '.join(f"{l} n{c} p{p:.2f}->{h:.2f}" for l,(c,p,h) in out[P]['cal_model'].items()))
    print('   calib mkt  :', '  '.join(f"{l} n{c} p{p:.2f}->{h:.2f}" for l,(c,p,h) in out[P]['cal_mkt'].items()))
json.dump(out,open('bt_eval_out.json','w'),indent=1)
