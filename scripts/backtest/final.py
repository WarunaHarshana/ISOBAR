import json,subprocess,concurrent.futures as cf,os
b=json.load(open('bias_fit.json'))['cv']
BL=dict(ahead=0,sameDay=[[10,0],[13,0.5],[16,0.75]])
jobs={
 'P1_depth_only':dict(minPriceYes=0.03,takerFeeRate=0,blend=None,stationBiasC={},biasLows=False),
 'P2_fee_floor12':dict(minPriceYes=0.12,takerFeeRate=0.05,blend=None,stationBiasC={},biasLows=False),
 'P3_plus_bias':dict(minPriceYes=0.12,takerFeeRate=0.05,blend=None,stationBiasC={},biasLows=False,cvBiasByDate=b),
 'P4_final':dict(minPriceYes=0.12,takerFeeRate=0.05,blend=BL,stationBiasC={},biasLows=False,cvBiasByDate=b),
 'P4_final_f10':dict(minPriceYes=0.10,takerFeeRate=0.05,blend=BL,stationBiasC={},biasLows=False,cvBiasByDate=b),
 'P4_final_f15':dict(minPriceYes=0.15,takerFeeRate=0.05,blend=BL,stationBiasC={},biasLows=False,cvBiasByDate=b),
 'P4_final_median':dict(minPriceYes=0.12,takerFeeRate=0.05,blend=BL,stationBiasC={},biasLows=False,cvBiasByDate=b),
 'P4_final_delay0':dict(minPriceYes=0.12,takerFeeRate=0.05,blend=BL,stationBiasC={},biasLows=False,cvBiasByDate=b),
 'P4_final_next':dict(minPriceYes=0.12,takerFeeRate=0.05,blend=BL,stationBiasC={},biasLows=False,cvBiasByDate=b),
}
def run(k):
    out=f'grid/{k}.json'
    env=dict(os.environ,ROOT='/workspace/ISOBAR',VARIANT=k,PARAMS=json.dumps(jobs[k]),OUT=out,DEPTH='median' if 'median' in k else 'p25')
    if 'delay0' in k: env['METAR_DELAY_MS']='0'
    if k.endswith('next'): env['PXMODE']='next'
    subprocess.run(['/home/box/node22/bin/node','--experimental-strip-types','--import','/workspace/ISOBAR/scripts/ts-test-resolve.mjs','bt_sim.ts'],env=env,capture_output=True)
    return k
with cf.ThreadPoolExecutor(5) as ex: list(ex.map(run,jobs))
