# Contact sheet per model/pipeline from scripts/report.ts renders: top row 5 views, bottom row plates + support risk.
# usage: python3 scripts/contact.py <dir>   (writes <model>_<h>_<tag>_sheet.png)
import glob, os, sys
from PIL import Image, ImageDraw
d = sys.argv[1]
labels = ['original', 'seams front', 'seams back', 'assembled', 'exploded + dowels']
for f in glob.glob(os.path.join(d, '*_1_original.png')):
    prefix = f[:-len('_1_original.png')]
    ks = ['1_original', '2_seams_front', '2_seams_back', '3_assembled', '4_exploded']
    if not all(os.path.exists(f'{prefix}_{k}.png') for k in ks + ['5_plates', '6_support_risk']): continue
    W = Image.new('RGB', (320 * 5, 320 + 450 + 20), (24, 26, 31))
    dr = ImageDraw.Draw(W)
    for i, k in enumerate(ks):
        W.paste(Image.open(f'{prefix}_{k}.png').resize((320, 320)), (i * 320, 0)); dr.text((i * 320 + 6, 4), labels[i], fill=(220, 220, 220))
    W.paste(Image.open(f'{prefix}_5_plates.png').resize((800, 450)), (0, 340)); dr.text((6, 324), 'build plates (180 mm squares, actual placed geometry)', fill=(220, 220, 220))
    W.paste(Image.open(f'{prefix}_6_support_risk.png').resize((800, 450)), (800, 340)); dr.text((806, 324), 'support risk, seen from below: red = support on visible surface, amber = hidden surface', fill=(220, 220, 220))
    dr.text((1300, 4), os.path.basename(prefix), fill=(255, 255, 120))
    W.save(f'{prefix}_sheet.png')
