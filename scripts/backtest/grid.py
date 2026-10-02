import json,subprocess,itertools,concurrent.futures as cf,os
b=json.load(open('bias_fit.json'))['cv']
def P(floor,ahead,knots): return dict(minPriceYes=floor,takerFeeRate=0.05,blend=dict(ahead=ahead,sameDay=knots),stationBiasC={},biasLows=False,cvBiasByDate=b)
jobs={}
for w in [0,0.25,0.4,0.5,0.6,0.75,1.0]:
    jobs[f'sd{w}_a0_f12']=P(0.12,0,[[9,w],[16,w]])
for w9,w16 in [(0,0.5),(0.25,0.5),(0.5,0.25),(0.5,0),(0.75,0.25),(0.25,0.75),(0,0.75)]:
    jobs[f'k9_{w9}_16_{w16}_a0_f12']=P(0.12,0,[[9,w9],[16,w16]])
for a in [0.25,0.5,1.0]:
    jobs[f'sd0.5_a{a}_f12']=P(0.12,a,[[9,0.5],[16,0.5]])
for f in [0.03,0.05,0.08,0.10,0.12,0.15,0.20]:
    jobs[f'sd0.5_a0_f{int(f*100)}']=P(f,0,[[9,0.5],[16,0.5]])
    jobs[f'w1_f{int(f*100)}']=dict(minPriceYes=f,takerFeeRate=0.05,blend=None,stationBiasC={},biasLows=False,cvBiasByDate=b)
def run(k):
    out=f'grid/{k}.json'
    if not os.path.exists(out):
        env=dict(os.environ,ROOT='/workspace/ISOBAR',VARIANT=k,PARAMS=json.dumps(jobs[k]),OUT=out)
        subprocess.run(['/home/box/node22/bin/node','--experimental-strip-types','--import','/workspace/ISOBAR/scripts/ts-test-resolve.mjs','bt_sim.ts'],env=env,capture_output=True)
    d=json.load(open(out)); F=d['fills']
    by={}
    for x in F: by.setdefault(x['point'],[0,0,0]); by[x['point']][0]+=1; by[x['point']][1]+=x['pnl']; by[x['point']][2]+=x['cost']
    return k,len(F),sum(x['won'] for x in F),sum(x['cost'] for x in F),sum(x['pnl'] for x in F),by
with cf.ThreadPoolExecutor(6) as ex:
    for k,n,w,c,p,by in ex.map(run,list(jobs)):
        print(f"{k:28s} fills {n:3d} won {w:3d} cost {c:6.0f} pnl {p:+6.0f} ROI {p/max(c,1):+.2f} | "+' '.join(f"{pt}:{v[0]}/{v[1]:+.0f}" for pt,v in sorted(by.items())))
