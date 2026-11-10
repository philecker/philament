"""Philament app icon: the header's spool logo, drawn in white on the app's emerald gradient.

It matches the logo at the top right of the app window: an outer ring, a translucent
filament disc, a solid hub and a center hole. Drawn on Apple's macOS icon grid (824 px
body on a 1024 px canvas) and rendered at every Retina size.
Run: python3 assets/make_icon.py assets  (needs: pip install cairosvg pillow)
"""
import io, math, os, struct, sys
import cairosvg
from PIL import Image

def squircle(cx=512, cy=512, r=412, n=5.0, steps=360):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append(f'{cx + r*math.copysign(abs(c)**(2/n), c):.2f},{cy + r*math.copysign(abs(s)**(2/n), s):.2f}')
    return 'M' + ' L'.join(pts) + ' Z'

BODY = squircle()
SHADOW = '''<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.30"/></filter>'''

def wrap(defs, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>{SHADOW}
<clipPath id="clip"><path d="{BODY}"/></clipPath>
{defs}</defs>
{body}
</svg>'''

# ---------- Spool, as in the header logo ----------
# The header logo is drawn on a 24-unit grid; here 1 unit = 27.5 px, centered on the icon
# (the spool spans about 73% of the icon's width).
U = 27.5

def spool(small=False, dark=False):
    ring_w = 1.8 * U * (1.45 if small else 1)     # thicker lines so it reads at 16-32 px
    disc_w = 1.4 * U * (1.45 if small else 1)
    if dark:
        # Dark mode: dark slate outside the spool, emerald filament, light hub
        bg = '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b3445"/><stop offset="1" stop-color="#0c1220"/></linearGradient>'
        ring, disc, disc_op, hole = '#34d399', '#10b981', 0.55, '#0f172a'
        glow = '<radialGradient id="glow" cx="0.5" cy="0.52" r="0.5"><stop offset="0" stop-color="#10b981" stop-opacity="0.35"/><stop offset="1" stop-color="#10b981" stop-opacity="0"/></radialGradient>'
    else:
        bg = '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="0.45" stop-color="#10b981"/><stop offset="1" stop-color="#047857"/></linearGradient>'
        ring, disc, disc_op, hole = '#ffffff', '#ffffff', 0.3, '#065f46'
        glow = ''
    defs = bg + glow + f'''
<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
<radialGradient id="hubG" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e2f7ef"/></radialGradient>
<filter id="glyph" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="{'#000000' if dark else '#064e3b'}" flood-opacity="0.45"/></filter>
'''
    shadow = '' if small else 'filter="url(#shadow)"'
    glyph_fx = '' if small else 'filter="url(#glyph)"'
    sheen = '' if small else f'<path d="{BODY}" fill="url(#sheen)" fill-opacity="{0.4 if dark else 1}"/>'
    if dark and not small:
        sheen += '<g clip-path="url(#clip)"><circle cx="512" cy="530" r="380" fill="url(#glow)"/></g>'
    edge = '' if small else f'<path d="{BODY}" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="4"/>'
    body = f'''
<path d="{BODY}" fill="url(#bg)" {shadow}/>
{sheen}
<g {glyph_fx}>
  <circle cx="512" cy="512" r="{10 * U}" fill="none" stroke="{ring}" stroke-width="{ring_w:.1f}"/>
  <circle cx="512" cy="512" r="{7.2 * U}" fill="{disc}" fill-opacity="{disc_op}" stroke="{ring}" stroke-width="{disc_w:.1f}"/>
  <circle cx="512" cy="512" r="{3.6 * U}" fill="url(#hubG)"/>
  <circle cx="512" cy="512" r="{1.4 * U}" fill="{hole}" fill-opacity="0.85"/>
</g>
{edge}
'''
    return wrap(defs, body)

def spool_small(dark=False):
    return spool(small=True, dark=dark)

def render(svg, px):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px))).convert('RGBA')

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(OUT, 'icon.iconset'), exist_ok=True)
open(os.path.join(OUT, 'icon.svg'), 'w').write(spool())

made = {}
def get(px):
    if px not in made:
        made[px] = render(spool_small() if px <= 32 else spool(), px)
    return made[px]

for pt in (16, 32, 128, 256, 512):
    get(pt).save(os.path.join(OUT, 'icon.iconset', f'icon_{pt}x{pt}.png'), optimize=True)
    get(pt * 2).save(os.path.join(OUT, 'icon.iconset', f'icon_{pt}x{pt}@2x.png'), optimize=True)
get(1024).save(os.path.join(OUT, 'icon.png'), optimize=True)
for px in (16, 32, 64, 128, 256, 512):
    get(px).save(os.path.join(OUT, f'icon-{px}.png'), optimize=True)

# .icns with every size macOS asks for, each stored as PNG (1x and 2x)
ICNS_TYPES = [(b'icp4', 16), (b'ic11', 32), (b'icp5', 32), (b'ic12', 64), (b'icp6', 64),
              (b'ic07', 128), (b'ic13', 256), (b'ic08', 256), (b'ic14', 512), (b'ic09', 512), (b'ic10', 1024)]
chunks = b''
for kind, px in ICNS_TYPES:
    buf = io.BytesIO()
    get(px).save(buf, format='PNG', optimize=True)
    data = buf.getvalue()
    chunks += kind + struct.pack('>I', len(data) + 8) + data
with open(os.path.join(OUT, 'icon.icns'), 'wb') as f:
    f.write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)

# Dark-mode artwork: used for the Dock while the app runs in dark mode, and in the .icon bundle
made_dark = {}
def get_dark(px):
    if px not in made_dark:
        made_dark[px] = render(spool_small(dark=True) if px <= 32 else spool(dark=True), px)
    return made_dark[px]
open(os.path.join(OUT, 'icon-dark.svg'), 'w').write(spool(dark=True))
get_dark(1024).save(os.path.join(OUT, 'icon-dark.png'), optimize=True)
get_dark(512).save(os.path.join(OUT, 'icon-dark-512.png'), optimize=True)

# Icon Composer bundle (macOS 26+): one icon with light and dark appearances.
# Each part of the spool is its own layer so macOS can add its glass depth and tint it.
import json, shutil
bundle = os.path.join(OUT, 'Philament.icon')
shutil.rmtree(bundle, ignore_errors=True)
os.makedirs(os.path.join(bundle, 'Assets'))
def layer_svg(shape):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">{shape}</svg>'
parts = {
    'ring.svg': f'<circle cx="512" cy="512" r="{10 * U}" fill="none" stroke="#ffffff" stroke-width="{1.8 * U}"/>',
    'filament.svg': f'<circle cx="512" cy="512" r="{7.2 * U}" fill="#ffffff" fill-opacity="0.3" stroke="#ffffff" stroke-width="{1.4 * U}"/>',
    'hub.svg': f'<path fill="#ffffff" fill-rule="evenodd" d="M512 {512 - 3.6 * U}a{3.6 * U} {3.6 * U} 0 1 1 0 {7.2 * U}a{3.6 * U} {3.6 * U} 0 1 1 0 -{7.2 * U}zM512 {512 - 1.4 * U}a{1.4 * U} {1.4 * U} 0 1 0 0 {2.8 * U}a{1.4 * U} {1.4 * U} 0 1 0 0 -{2.8 * U}z"/>',
}
for name, shape in parts.items():
    open(os.path.join(bundle, 'Assets', name), 'w').write(layer_svg(shape))
def srgb(hex_, a=1.0):
    r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return f'srgb:{r:.5f},{g:.5f},{b:.5f},{a:.5f}'
def layer(name, light, dark):
    return {
        'image-name': name, 'name': name.split('.')[0], 'glass': True,
        'fill-specializations': [
            {'value': {'solid': light}},
            {'appearance': 'dark', 'value': {'solid': dark}},
        ],
    }
icon = {
    'fill-specializations': [
        {'value': {'linear-gradient': [srgb('#34d399'), srgb('#047857')]}},
        {'appearance': 'dark', 'value': {'linear-gradient': [srgb('#2b3445'), srgb('#0c1220')]}},
    ],
    'groups': [{
        'name': 'Spool',
        'layers': [
            layer('hub.svg', srgb('#ffffff'), srgb('#f1f5f9')),
            layer('filament.svg', srgb('#ffffff', 0.85), srgb('#10b981')),
            layer('ring.svg', srgb('#ffffff'), srgb('#34d399')),
        ],
        'shadow': {'kind': 'neutral', 'opacity': 0.5},
        'translucency': {'enabled': True, 'value': 0.3},
        'specular': True,
    }],
    'supported-platforms': {'circles': ['watchOS'], 'squares': 'shared'},
}
open(os.path.join(bundle, 'icon.json'), 'w').write(json.dumps(icon, indent=2))
print('icon written to', OUT)
