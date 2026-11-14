# Before/after table from scripts/report.ts JSON (same evaluator for both pipelines) + Bambu Studio slicing results.
# usage: python3 scripts/summarize.py out/report out/e2e > docs/REPORT_TABLE.md
import json, os, sys, glob
rep, e2e = sys.argv[1], sys.argv[2]
rows = []
for f in sorted(glob.glob(os.path.join(rep, '*_after.json'))):
    a = json.load(open(f)); bf = f.replace('_after.json', '_before.json')
    b = json.load(open(bf)) if os.path.exists(bf) else None
    key = f"{a['model']}_{a['height']}"
    bbs = os.path.join(e2e, key + '.bbs.json')
    s = None
    if os.path.exists(bbs):
        try: s = json.loads(open(bbs).read().strip().splitlines()[-1])
        except Exception: s = None
    rows.append((a, b, s))
def v(d, k): return '—' if d is None else d['eval'][k]
print('| Model | parts (before→after) | plates | dowels | seam mm, visibility-weighted | support on visible mm² | support total mm² | min bed contact mm² | curved seams | checks | Bambu Studio slice (after) |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
for a, b, s in rows:
    fails = [k for k, x in a['checks'].items() if x.startswith('FAIL')]
    if s is None: sl = 'not run'
    elif s.get('ok'): sl = 'OK, %d plate(s), support %.1f cm³ of %.1f cm³' % (s['slicedPlates'], sum(p['supportFilamentMm3'] for p in s['perPlate']) / 1000, sum(p['totalFilamentMm3'] for p in s['perPlate']) / 1000)
    else: sl = 'FAIL: ' + (s.get('error') or '')[:60].strip() + ('; ' + '; '.join(s.get('mismatches', [])[:2]) if s.get('mismatches') else '')
    print(f"| {a['model']} @{a['height']} mm | {b['bodies'] if b else '—'} → {a['bodies']} | {b['plates'] if b else '—'} → {a['plates']} | {b['dowels'] if b else '—'} → {a['dowels']} "
          f"| {v(b,'seamVisibilityWeightedMm')} → {v(a,'seamVisibilityWeightedMm')} | {v(b,'supportOnVisibleMm2')} → {v(a,'supportOnVisibleMm2')} | {v(b,'supportAreaMm2')} → {v(a,'supportAreaMm2')} "
          f"| {v(b,'minBedContactMm2')} → {v(a,'minBedContactMm2')} | {sum(1 for c in a.get('curved', []) if c)}/{len(a.get('curved', []))} | {'all PASS' if not fails else 'FAIL: ' + ', '.join(fails)} | {sl} |")
