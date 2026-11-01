/* NOVA — Fleet Bridge 的副官角色。纯 SVG + JS，无依赖，所有图形由代码绘制。
   Q版（chibi）画风：大圆头、无眼白的大圆眼、圆润刘海、猫耳耳机、浅色系。
   用法：
     const nova = Nova.create(el, { name: 'NOVA', bubble: true });
     nova.setMood('PERMIT');   // 与 Fleet Bridge 的事件类型一致
     nova.say('FLEET-02 请求授权！');
   心情：PERMIT ALERT OVERLOAD READY GIT SYS RECHARGED ENGAGED STANDBY */
(function (global) {
  'use strict';

  // 左右对称：只写左半边的路径，右半边按 x=160 镜像。只用于全是坐标对的绝对命令（M L C Q Z）。
  const mx = (d) => {
    let i = 0;
    return d.replace(/-?\d+(\.\d+)?/g, (v) => (i++ % 2 === 0 ? String(+(320 - v).toFixed(2)) : v));
  };
  const pair = (d) => [d, mx(d)];

  // eyes: 眼睛形态 / brows: 眉毛 / mouth: 嘴型 / arm: 手的动作 / fx: 头顶特效
  const MOODS = {
    ENGAGED:   { eyes: 'normal', brows: 'flat',  mouth: 'cat',     blush: 0.5,  arm: null,    fx: null,    glow: '#3df5ff' },
    STANDBY:   { eyes: 'sleep',  brows: 'calm',  mouth: 'o',       blush: 0.6,  arm: null,    fx: 'zzz',   glow: '#7fa3b8' },
    PERMIT:    { eyes: 'wide',   brows: 'up',    mouth: 'open',    blush: 0.6,  arm: 'raise', fx: '!',     glow: '#ff4d6d' },
    ALERT:     { eyes: 'shock',  brows: 'worry', mouth: 'wavy',    blush: 0.3,  arm: null,    fx: '!',     glow: '#ff4d6d', sweat: true, shake: true },
    OVERLOAD:  { eyes: 'normal', brows: 'worry', mouth: 'frown',   blush: 0.4,  arm: null,    fx: null,    glow: '#ff4d6d', sweat: true },
    READY:     { eyes: 'happy',  brows: 'calm',  mouth: 'grin',    blush: 0.7,  arm: 'wave',  fx: null,    glow: '#ffb020' },
    GIT:       { eyes: 'focus',  brows: 'angry', mouth: 'flat',    blush: 0.4,  arm: null,    fx: '…',     glow: '#ffb020' },
    SYS:       { eyes: 'wide',   brows: 'up',    mouth: 'o',       blush: 0.5,  arm: null,    fx: '!?',    glow: '#7fa3b8' },
    RECHARGED: { eyes: 'happy',  brows: 'up',    mouth: 'grin',    blush: 0.9,  arm: 'cheer', fx: 'spark', glow: '#4dffa6' },
  };

  // s: 眼睛纵向缩放，pupil: 瞳孔缩放；sleep / happy 用闭眼线代替
  const EYE_Y = 196;
  const EYES = {
    normal: { s: 1, pupil: 1 },
    focus:  { s: 0.62, pupil: 1 },
    wide:   { s: 1.1, pupil: 0.85 },
    shock:  { s: 1.12, pupil: 0.55 },
    sleep:  { closed: pair('M102 198 Q120 210 138 198') },
    happy:  { closed: pair('M102 204 Q120 184 138 204') },
  };

  const BROWS = {
    calm:  pair('M110 165 Q120 160 130 164'),
    flat:  pair('M110 164 Q120 162 130 164'),
    up:    pair('M110 159 Q120 153 130 158'),
    worry: pair('M110 165 Q120 162 130 157'),
    angry: pair('M110 158 Q120 160 130 166'),
  };

  // tongue: 舌头的 y（有它就是张开的嘴）
  const MOUTHS = {
    cat:     { d: 'M150 225 Q155 231 160 226 Q165 231 170 225' },
    neutral: { d: 'M155 227 Q160 230 165 227' },
    smile:   { d: 'M152 225 Q160 233 168 225' },
    frown:   { d: 'M154 231 Q160 225 166 231' },
    wavy:    { d: 'M149 229 Q152 226 155 229 Q158 232 161 229 Q164 226 167 229 Q170 232 171 229' },
    flat:    { d: 'M155 228 L165 228' },
    grin:    { d: 'M150 222 Q160 224 170 222 Q167 237 160 237 Q153 237 150 222 Z', tongue: 237 },
    open:    { d: 'M154 223 Q160 221 166 223 Q165 234 160 235 Q155 234 154 223 Z', tongue: 235 },
    o:       { d: 'M160 223 C165 223 165 233 160 233 C155 233 155 223 160 223 Z', tongue: 233 },
    talk:    { d: 'M154 224 Q160 223 166 224 Q164 231 160 231 Q156 231 154 224 Z', tongue: 231 },
  };

  const FRAME_MS = 1000 / 30;

  const POKE_LINES = ['呀！', '舰长，别戳我啦……', '在呢在呢！', '有新命令吗？', '我在认真盯着呢！'];

  const C = {
    line: '#4a5aa8',      // 头发线稿
    eyeLine: '#26305e',
    skinLine: '#e3a593',
    skinShade: '#f8cfc1',
    hairShade: '#6c80d8',
    ring: '#f0f5ff',      // 头顶高光
    coatLine: '#1b2848',
    gold: '#f2cf72',
  };

  const FACE = 'M68 178 C68 108 252 108 252 178 C252 238 214 266 160 266 C106 266 68 238 68 178 Z';
  const BANGS = 'M64 178 C50 28 270 28 256 178 Q250 150 236 140 Q232 162 218 160 Q212 132 196 128 Q192 152 176 152 ' +
    'Q170 126 160 124 Q150 126 144 152 Q128 152 124 128 Q108 132 102 160 Q88 162 84 140 Q70 150 64 178 Z';
  const LOCK = 'M66 168 C54 210 58 252 74 280 Q86 272 88 252 C90 224 86 198 82 176 Z';

  const CSS = `
.nova{position:relative;aspect-ratio:320/380;--nova-glow:#3df5ff;user-select:none;-webkit-user-select:none;container-type:inline-size}
.nova-halo{position:absolute;left:8%;right:8%;top:6%;bottom:22%;border-radius:50%;pointer-events:none;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--nova-glow) 30%,transparent),transparent);
  animation:nova-pulse 3.2s ease-in-out infinite}
.nova-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;cursor:pointer}
.nova-ring{fill:none;stroke:var(--nova-glow);transform-origin:160px 176px;transition:stroke .4s}
.nova-ring.a{opacity:.35;animation:nova-spin 26s linear infinite}
.nova-ring.b{opacity:.2;animation:nova-spin 18s linear infinite reverse}
.nova-glowfill{fill:var(--nova-glow);transition:fill .4s}
.nova-glowline{stroke:var(--nova-glow);transition:stroke .4s}
.nova-fx{position:absolute;inset:0;pointer-events:none}
.nova-fx>*{display:none;position:absolute}
.nova[data-fx="!"] .nova-mark,.nova[data-fx="!?"] .nova-mark,.nova[data-fx="…"] .nova-mark{display:block}
.nova[data-fx=zzz] .nova-zzz,.nova[data-fx=spark] .nova-spark{display:block}
.nova-mark{left:76%;top:12%;padding:2.5% 3.5%;border-radius:40%;text-align:center;
  font:900 clamp(12px,7cqw,34px)/1 'Orbitron',system-ui,sans-serif;color:#04060c;background:var(--nova-glow);
  box-shadow:0 0 14px var(--nova-glow);animation:nova-pop .9s ease-in-out infinite}
.nova-zzz{left:66%;top:12%;font:700 clamp(10px,6cqw,28px)/1 'Orbitron',system-ui,sans-serif;color:var(--nova-glow)}
.nova-zzz span{position:absolute;opacity:0;animation:nova-z 3s ease-in infinite}
.nova-zzz span:nth-child(2){animation-delay:1s;font-size:.8em}
.nova-zzz span:nth-child(3){animation-delay:2s;font-size:.6em}
.nova-spark{inset:0}
.nova-spark i{position:absolute;width:6%;aspect-ratio:1;background:var(--nova-glow);
  clip-path:polygon(50% 0,62% 38%,100% 50%,62% 62%,50% 100%,38% 62%,0 50%,38% 38%);animation:nova-twinkle 1.4s ease-in-out infinite}
.nova-spark i:nth-child(1){left:12%;top:18%}
.nova-spark i:nth-child(2){left:80%;top:10%;animation-delay:.3s;width:8%}
.nova-spark i:nth-child(3){left:6%;top:48%;animation-delay:.6s;width:4%}
.nova-spark i:nth-child(4){left:86%;top:40%;animation-delay:.9s;width:5%}
.nova-spark i:nth-child(5){left:24%;top:6%;animation-delay:1.1s;width:4%}
.nova-say{position:absolute;left:3%;right:3%;bottom:2%;padding:10px 14px 12px;opacity:0;transform:translateY(8px);
  transition:opacity .25s,transform .25s;pointer-events:none;color:#ddf6ff;
  background:rgba(7,16,25,.88);border:1px solid var(--nova-glow);box-shadow:0 0 18px color-mix(in srgb,var(--nova-glow) 30%,transparent);
  clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
.nova-say.on{opacity:1;transform:none}
.nova-say b{display:block;font:700 12px/1.2 'Orbitron',system-ui,sans-serif;letter-spacing:2px;color:var(--nova-glow);margin-bottom:4px}
.nova-say p{margin:0;font:500 14px/1.55 'Noto Sans SC',system-ui,sans-serif;min-height:1.55em}
@keyframes nova-spin{to{transform:rotate(360deg)}}
@keyframes nova-pulse{50%{opacity:.55}}
@keyframes nova-pop{0%,100%{transform:translateY(0) scale(1)}40%{transform:translateY(-12%) scale(1.08)}}
@keyframes nova-z{0%{opacity:0;transform:translate(0,0)}20%{opacity:1}100%{opacity:0;transform:translate(60%,-160%)}}
@keyframes nova-twinkle{0%,100%{opacity:.15;transform:scale(.5) rotate(0)}50%{opacity:1;transform:scale(1) rotate(45deg)}}
@media (prefers-reduced-motion:reduce){.nova-ring,.nova-halo,.nova-mark,.nova-zzz span,.nova-spark i{animation:none}}`;

  // 一只眼睛：深色渐变的大椭圆（无眼白）→ 瞳孔 → 两个高光 → 上眼线和外眼角的小睫毛
  function eyeMarkup(p, R) {
    const s = R ? 'R' : 'L';
    const X = (x) => (R ? 320 - x : x);
    const P = (d) => (R ? mx(d) : d);
    const c = X(120);
    const hl = c - 7; // 高光两只眼都在左上，光源一致
    return `
  <g data-n="open${s}">
    <g data-n="eye${s}">
      <ellipse cx="${c}" cy="196" rx="17" ry="21" fill="url(#${p}-iris)"/>
      <g clip-path="url(#${p}-eye${s})">
        <path d="${P('M100 204 Q120 222 140 204 L140 220 L100 220 Z')}" fill="#9ef2ff" opacity=".5"/>
        <g data-n="iris${s}">
          <ellipse cx="${c}" cy="198" rx="13" ry="17" fill="none" stroke="#9ef2ff" stroke-width="1.2" opacity=".35"/>
          <g data-n="pupil${s}"><ellipse cx="${c}" cy="198" rx="8" ry="11" fill="#141b44" opacity=".8"/></g>
          <ellipse cx="${hl}" cy="187" rx="6.5" ry="7.5" fill="#fff"/>
          <circle cx="${hl + 14}" cy="207" r="3" fill="#fff" opacity=".95"/>
          <path d="M${hl + 16} 182 L${hl + 17.2} 185.8 L${hl + 21} 187 L${hl + 17.2} 188.2 L${hl + 16} 192 L${hl + 14.8} 188.2 L${hl + 11} 187 L${hl + 14.8} 185.8 Z" fill="#fff"/>
          <circle cx="${hl + 4}" cy="210" r="1.2" fill="#fff" opacity=".7"/>
        </g>
        <path d="${P('M98 170 L142 170 L142 188 Q120 180 98 190 Z')}" fill="#141b44" opacity=".45"/>
      </g>
      <path d="${P('M100 193 Q101 171 120 171 Q137 171 141 186 L141 190 Q134 177 120 177 Q106 177 104 195 Z')}" fill="${C.eyeLine}"/>
      <path d="${P('M101 185 Q96 181 91 181 M102 180 Q99 174 94 171')}" stroke="${C.eyeLine}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <path d="${P('M106 213 Q110 217 115 218')}" stroke="${C.eyeLine}" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".45"/>
    </g>
  </g>
  <path data-n="closed${s}" d="" stroke="${C.eyeLine}" stroke-width="3.4" fill="none" stroke-linecap="round"/>`;
  }

  function svgMarkup(p, name) {
    const [lockL, lockR] = pair(LOCK);
    const cup = (R) => {
      const X = (x) => (R ? 320 - x : x);
      return `<circle cx="${X(68)}" cy="190" r="19" fill="#f4f7ff" stroke="${C.line}" stroke-width="2"/>
        <circle cx="${X(68)}" cy="190" r="11" fill="#fff" class="nova-glowline" stroke-width="3"/>
        <circle cx="${X(68)}" cy="190" r="4.5" class="nova-glowfill"/>`;
    };
    const catEar = (R) => {
      const P = (d) => (R ? mx(d) : d);
      return `<path d="${P('M90 96 L94 46 L134 72 Z')}" fill="#f4f7ff" stroke="${C.line}" stroke-width="2.4" stroke-linejoin="round"/>
        <path d="${P('M99 84 L101 60 L122 74 Z')}" class="nova-glowfill" opacity=".85" stroke-linejoin="round"/>`;
    };

    return `<svg class="nova-svg" viewBox="0 0 320 380" role="img" aria-label="${name}">
<defs>
  <linearGradient id="${p}-hair" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="280">
    <stop offset="0" stop-color="#a8c0ff"/><stop offset=".6" stop-color="#8aa4f2"/><stop offset="1" stop-color="#86d6f2"/></linearGradient>
  <linearGradient id="${p}-coat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34507f"/><stop offset="1" stop-color="#1f3156"/></linearGradient>
  <radialGradient id="${p}-skin" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="#fff7f2"/><stop offset="1" stop-color="#ffe9df"/></radialGradient>
  <linearGradient id="${p}-iris" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#27306b"/><stop offset=".55" stop-color="#2f6fb8"/><stop offset="1" stop-color="#55d6f0"/></linearGradient>
  <radialGradient id="${p}-blush"><stop offset="0" stop-color="#ff8fab" stop-opacity=".9"/><stop offset="1" stop-color="#ff8fab" stop-opacity="0"/></radialGradient>
  <clipPath id="${p}-eyeL"><ellipse cx="120" cy="196" rx="17" ry="21"/></clipPath>
  <clipPath id="${p}-eyeR"><ellipse cx="200" cy="196" rx="17" ry="21"/></clipPath>
  <clipPath id="${p}-bangs-clip"><path d="${BANGS}"/></clipPath>
  <clipPath id="${p}-face"><path d="${FACE}"/></clipPath>
  <clipPath id="${p}-mouth"><path data-n="mouthClip" d=""/></clipPath>
</defs>
<circle class="nova-ring a" cx="160" cy="176" r="134" stroke-width="1.5" stroke-dasharray="3 9 46 9"/>
<circle class="nova-ring b" cx="160" cy="176" r="120" stroke-width="1" stroke-dasharray="1 6"/>

<g data-n="headBack">
  <path fill="url(#${p}-hair)" stroke="${C.line}" stroke-width="2" stroke-linejoin="round"
    d="M58 180 C46 40 274 40 262 180 C266 230 258 262 244 282 C232 274 226 256 222 240 L98 240 C94 256 88 274 76 282 C62 262 54 230 58 180 Z"/>
</g>

<g data-n="body">
  <g transform="translate(0 -10)">
  <path d="M149 248 C150 264 149 278 147 294 L173 294 C171 278 170 264 171 248 Z" fill="#ffe9df" stroke="${C.skinLine}" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M149 248 L171 248 L171 270 Q160 279 149 270 Z" fill="${C.skinShade}"/>
  ${pair('M112 306 Q98 326 95 360 Q103 367 112 363 Q114 336 126 318 Z').map((d, i) =>
    `<g${i ? ' data-n="armRest"' : ''}><path d="${d}" fill="url(#${p}-coat)" stroke="${C.coatLine}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${i ? 216 : 104}" cy="369" r="8" fill="#fff4ee" stroke="${C.skinLine}" stroke-width="1.8"/></g>`).join('')}
  <path fill="url(#${p}-coat)" stroke="${C.coatLine}" stroke-width="2" stroke-linejoin="round"
    d="M98 392 C97 336 106 308 126 298 Q142 290 160 290 Q178 290 194 298 C214 308 223 336 222 392 Z"/>
  <path d="M222 392 C223 336 214 308 194 298 Q206 330 204 392 Z" fill="#14213f" opacity=".6"/>
  <path d="M98 392 C97 340 104 316 118 304 Q110 336 112 392 Z" fill="#14213f" opacity=".35"/>
  <path d="M160 322 L160 392" stroke="${C.coatLine}" stroke-width="1.4" opacity=".7"/>
  ${[[150, 340], [170, 340], [150, 362], [170, 362]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.8" fill="${C.gold}" stroke="#9a7424" stroke-width="1"/>`).join('')}
  ${pair('M148 289 Q126 292 110 306 Q114 324 130 332 L160 322 Z').map((d) => `<path d="${d}" fill="#f4f7ff" stroke="${C.coatLine}" stroke-width="1.6" stroke-linejoin="round"/>`).join('')}
  ${pair('M116 310 Q126 322 142 326').map((d) => `<path d="${d}" class="nova-glowline" stroke-width="2.2" fill="none" stroke-linecap="round"/>`).join('')}
  <path d="M148 289 L160 312 L172 289 Z" fill="#dfe8f6" stroke="${C.coatLine}" stroke-width="1.2" stroke-linejoin="round"/>
  ${pair('M157 315 L150 336 L156 334 L160 318 Z').map((d) => `<path d="${d}" class="nova-glowfill" stroke="${C.coatLine}" stroke-width="1.4" stroke-linejoin="round"/>`).join('')}
  ${pair('M160 314 Q146 302 138 307 Q135 320 147 322 Z').map((d) => `<path d="${d}" class="nova-glowfill" stroke="${C.coatLine}" stroke-width="1.5" stroke-linejoin="round"/>`).join('')}
  <circle cx="160" cy="315" r="4.5" class="nova-glowfill" stroke="${C.coatLine}" stroke-width="1.5"/>
  <path d="M176 346 L206 346 L206 357 L176 357 Z" fill="#0e1a33" class="nova-glowline" stroke-width="1"/>
  <text x="191" y="354.5" text-anchor="middle" font-family="Orbitron,system-ui,sans-serif" font-weight="700" font-size="6.5" letter-spacing="1" class="nova-glowfill">${name}</text>
  <path d="M128 344 L134 347.5 L134 354.5 L128 358 L122 354.5 L122 347.5 Z" fill="none" class="nova-glowline" stroke-width="1.4"/>
  <circle cx="128" cy="351" r="2.2" class="nova-glowfill"/>
  </g>
</g>

<g data-n="head">
  <path d="${FACE}" fill="url(#${p}-skin)" stroke="${C.skinLine}" stroke-width="2"/>
  <path clip-path="url(#${p}-face)" fill="${C.skinShade}" opacity=".75" d="M64 188 Q76 170 84 150 Q92 172 104 170 Q118 168 124 138 Q134 164 146 162 Q156 158 160 134 Q164 158 174 162 Q186 164 196 138 Q202 168 216 170 Q228 172 236 150 Q244 170 256 188 L256 90 L64 90 Z"/>
  <path d="M158.5 214 Q160 216.5 161.5 214" stroke="#e39a88" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  <g data-n="blush" opacity=".5">
    <ellipse cx="98" cy="226" rx="18" ry="11" fill="url(#${p}-blush)"/>
    <ellipse cx="222" cy="226" rx="18" ry="11" fill="url(#${p}-blush)"/>
    ${pair('M90 228 L94 222 M96 229 L100 223 M102 229 L106 223').map((d) => `<path d="${d}" stroke="#ff7d98" stroke-width="1.6" stroke-linecap="round"/>`).join('')}
  </g>
  <path data-n="mouth" d="" stroke="#a0465a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <g clip-path="url(#${p}-mouth)">
    <ellipse data-n="tongue" cx="160" cy="236" rx="7" ry="4.5" fill="#ff9aac"/>
  </g>
  ${eyeMarkup(p, false)}
  ${eyeMarkup(p, true)}
  <g data-n="sweat" display="none"><path d="M238 150 C230 162 230 170 238 170 C246 170 246 162 238 150 Z" fill="#c8f4ff" stroke="#6fb6d8" stroke-width="1.5"/></g>

${[lockL, lockR].map((d, i) => `  <g data-n="lock${i ? 'R' : 'L'}"><path d="${d}" fill="url(#${p}-hair)" stroke="${C.line}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${pair('M72 190 C66 220 68 250 76 270')[i]}" stroke="${C.line}" stroke-width="1.2" fill="none" opacity=".4"/>
    <path d="${pair('M60 244 Q74 250 88 244 L89 253 Q74 259 61 253 Z')[i]}" class="nova-glowfill" stroke="${C.coatLine}" stroke-width="1.4" stroke-linejoin="round"/></g>`).join('')}
  <g data-n="ahoge"><path d="M156 62 C146 34 172 22 186 32 C172 32 164 42 164 62 Z" fill="url(#${p}-hair)" stroke="${C.line}" stroke-width="2" stroke-linejoin="round"/></g>
  <path d="${BANGS}" fill="url(#${p}-hair)"/>
  <g clip-path="url(#${p}-bangs-clip)">
    <path d="M196 128 Q200 108 214 100 Q206 120 206 146 Z M124 128 Q120 108 106 100 Q114 120 114 146 Z M160 124 Q156 104 160 90 Q166 106 166 130 Z" fill="${C.hairShade}" opacity=".55"/>
    <path d="M160 124 Q157 100 162 78 M124 128 Q121 104 132 84 M196 128 Q199 104 188 84 M102 160 Q96 130 104 104 M218 160 Q224 130 216 104" stroke="${C.line}" stroke-width="1.3" fill="none" opacity=".35" stroke-linecap="round"/>
    <path d="M96 96 Q160 60 224 96 Q218 104 208 100 Q160 78 112 100 Q102 104 96 96 Z" fill="${C.ring}" opacity=".85"/>
  </g>
  <path d="${BANGS}" fill="none" stroke="${C.line}" stroke-width="2" stroke-linejoin="round"/>
  <path d="M92 132 L97 124 L104 128 L99 136 Z" fill="${C.gold}" stroke="#9a7424" stroke-width="1.2" stroke-linejoin="round"/>

  <path data-n="browL" d="" stroke="${C.line}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <path data-n="browR" d="" stroke="${C.line}" stroke-width="2.6" fill="none" stroke-linecap="round"/>

  ${catEar(false)}${catEar(true)}
  <path d="M68 172 C58 40 262 40 252 172" stroke="${C.line}" stroke-width="9" fill="none" stroke-linecap="round"/>
  <path d="M68 172 C58 40 262 40 252 172" stroke="#f4f7ff" stroke-width="5" fill="none" stroke-linecap="round"/>
  ${cup(false)}${cup(true)}
</g>

<g data-n="arm" display="none">
  <path d="M-12 0 L-10 -42 L10 -42 L12 0 Z" fill="url(#${p}-coat)" stroke="${C.coatLine}" stroke-width="2" stroke-linejoin="round"/>
  <rect x="-11" y="-46" width="22" height="7" rx="3" fill="${C.gold}" stroke="#9a7424" stroke-width="1"/>
  <circle cx="0" cy="-56" r="11" fill="#fff4ee" stroke="${C.skinLine}" stroke-width="2"/>
</g>
</svg>`;
  }

  let seq = 0;
  let styled = false;

  function create(container, opts = {}) {
    const name = opts.name || 'NOVA';
    const bubble = opts.bubble !== false;
    if (!styled) {
      const st = document.createElement('style');
      st.textContent = CSS;
      document.head.appendChild(st);
      styled = true;
    }

    const root = document.createElement('div');
    root.className = 'nova';
    root.innerHTML = `<div class="nova-halo"></div>${svgMarkup('nova' + ++seq, name)}
      <div class="nova-fx"><div class="nova-mark"></div><div class="nova-zzz"><span>Z</span><span>z</span><span>z</span></div>
      <div class="nova-spark"><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="nova-say"><b>${name}</b><p></p></div>`;
    container.appendChild(root);

    const svg = root.querySelector('svg');
    const n = (k) => svg.querySelector(`[data-n="${k}"]`);
    const el = {
      head: n('head'), headBack: n('headBack'), body: n('body'), arm: n('arm'), armRest: n('armRest'),
      lockL: n('lockL'), lockR: n('lockR'), ahoge: n('ahoge'), blush: n('blush'), sweat: n('sweat'),
      openL: n('openL'), openR: n('openR'), eyeL: n('eyeL'), eyeR: n('eyeR'), irisL: n('irisL'), irisR: n('irisR'),
      pupilL: n('pupilL'), pupilR: n('pupilR'), closedL: n('closedL'), closedR: n('closedR'),
      browL: n('browL'), browR: n('browR'), mouth: n('mouth'), mouthClip: n('mouthClip'), tongue: n('tongue'),
    };
    const mark = root.querySelector('.nova-mark');
    const sayBox = root.querySelector('.nova-say');
    const sayText = sayBox.querySelector('p');
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1;
    const icL = 120, icR = 200;

    let mood = 'ENGAGED';
    let override = null; // { mood, until } 被戳时的临时表情
    let talkUntil = 0;
    let bounceAt = -1e9, pokeAt = -1e9;
    let blinkAt = -1e9, nextBlink = performance.now() + 1500;
    let tx = 0, ty = 0, lx = 0, ly = 0;
    let shownFace = '';
    let shownMouth = '';
    let typer = 0, hideTimer = 0, raf = 0;

    const set = (node, attr, v) => node.setAttribute(attr, v);

    function applyFace(m) {
      const cfg = MOODS[m];
      const eyes = EYES[cfg.eyes];
      el.openL.style.display = el.openR.style.display = eyes.closed ? 'none' : '';
      set(el.closedL, 'd', eyes.closed ? eyes.closed[0] : '');
      set(el.closedR, 'd', eyes.closed ? eyes.closed[1] : '');
      set(el.browL, 'd', BROWS[cfg.brows][0]);
      set(el.browR, 'd', BROWS[cfg.brows][1]);
      set(el.blush, 'opacity', cfg.blush);
      set(el.sweat, 'display', cfg.sweat ? 'inline' : 'none');
      set(el.arm, 'display', cfg.arm ? 'inline' : 'none');
      set(el.armRest, 'display', cfg.arm ? 'none' : 'inline');
      root.style.setProperty('--nova-glow', cfg.glow);
      root.dataset.mood = m;
      root.dataset.fx = cfg.fx || '';
      mark.textContent = cfg.fx && cfg.fx.length <= 2 ? cfg.fx : '';
    }

    function setMouth(k) {
      if (k === shownMouth) return;
      shownMouth = k;
      const mo = MOUTHS[k];
      const open = mo.tongue != null;
      set(el.mouth, 'd', mo.d);
      set(el.mouth, 'fill', open ? '#a8304a' : 'none');
      set(el.mouthClip, 'd', open ? mo.d : '');
      if (open) set(el.tongue, 'cy', mo.tongue);
    }

    function onMove(e) {
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height * 0.48;
      tx = Math.max(-1, Math.min(1, (e.clientX - cx) / (innerWidth / 2)));
      ty = Math.max(-1, Math.min(1, (e.clientY - cy) / (innerHeight / 2)));
    }
    function onLeave() { tx = ty = 0; }

    // 限帧 + 不可见时不画：她一直在动，满帧跑会白白占用 GPU（Live2D 就是因此被去掉的）
    let drawnAt = 0;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - drawnAt < FRAME_MS) return;
      drawnAt = now;
      const t = now / 1000;
      if (override && now > override.until) override = null;
      const m = override ? override.mood : mood;
      if (m !== shownFace) { applyFace(m); shownFace = m; }
      const cfg = MOODS[m];
      const sleepy = m === 'STANDBY';

      // 视线跟随鼠标（睡着时不跟）
      const gx = sleepy ? 0 : tx, gy = sleepy ? 0 : ty;
      lx += (gx - lx) * 0.08;
      ly += (gy - ly) * 0.08;

      const breath = Math.sin((t * 2 * Math.PI) / (sleepy ? 4.6 : 3.2));
      const bounce = Math.max(0, 1 - (now - bounceAt) / 360);
      set(el.body, 'transform', `translate(0 ${breath * 1.2})`);

      let rot = (Math.sin(t * 0.9) * 1.2 + lx * 3) * calm;
      if (sleepy) rot += 7 + Math.sin(t * 1.1) * 1.5 * calm;
      if (cfg.shake) rot += Math.sin(t * 38) * 0.7 * calm;
      const poke = Math.max(0, 1 - (now - pokeAt) / 600);
      rot += Math.sin(t * 30) * 2.5 * poke;
      const hx = lx * 4 * calm;
      const hy = ly * 3 * calm + breath * 1.8 + (sleepy ? 4 : 0) - Math.sin(bounce * Math.PI) * 7;
      const headT = `translate(${hx} ${hy}) rotate(${rot} 160 280)`;
      set(el.head, 'transform', headT);
      set(el.headBack, 'transform', headT);
      set(el.lockL, 'transform', `rotate(${(Math.sin(t * 1.4) * 1.8 - rot * 0.3) * calm} 72 170)`);
      set(el.lockR, 'transform', `rotate(${(Math.sin(t * 1.4 + 1) * 1.8 - rot * 0.3) * calm} 248 170)`);
      set(el.ahoge, 'transform', `rotate(${Math.sin(t * 2.2) * 7 * calm} 160 62)`);

      // 眨眼
      if (now > nextBlink) {
        blinkAt = now;
        nextBlink = now + (Math.random() < 0.2 ? 260 : 2200 + Math.random() * 3200);
      }
      const bd = (now - blinkAt) / 140;
      const blink = bd < 1 ? 1 - Math.sin(bd * Math.PI) * 0.92 : 1;
      const eyes = EYES[cfg.eyes];
      if (!eyes.closed) {
        const s = eyes.s * blink;
        const eyeT = `matrix(1 0 0 ${s} 0 ${EYE_Y * (1 - s)})`;
        set(el.eyeL, 'transform', eyeT);
        set(el.eyeR, 'transform', eyeT);
        const irisT = `translate(${lx * 3.5} ${ly * 2.5})`;
        set(el.irisL, 'transform', irisT);
        set(el.irisR, 'transform', irisT);
        const ps = eyes.pupil;
        set(el.pupilL, 'transform', `matrix(${ps} 0 0 ${ps} ${icL * (1 - ps)} ${198 * (1 - ps)})`);
        set(el.pupilR, 'transform', `matrix(${ps} 0 0 ${ps} ${icR * (1 - ps)} ${198 * (1 - ps)})`);
      }

      // 说话时嘴巴开合
      if (now < talkUntil) {
        const rest = MOUTHS[cfg.mouth].tongue != null ? 'smile' : cfg.mouth;
        setMouth(Math.floor(now / 105) % 3 === 0 ? rest : 'talk');
      } else {
        setMouth(cfg.mouth);
      }

      if (cfg.sweat) {
        const k = (t * 0.7) % 1;
        set(el.sweat, 'transform', `translate(0 ${k * 10})`);
        set(el.sweat, 'opacity', k < 0.8 ? 1 : (1 - k) * 5);
      }

      if (cfg.arm) {
        let a = 28, dy = 0;
        if (cfg.arm === 'raise') a = 28 + Math.sin(t * 2) * 3;
        if (cfg.arm === 'wave') a = 30 + Math.sin(t * 9) * 16 * calm;
        if (cfg.arm === 'cheer') { a = 22; dy = -Math.abs(Math.sin(t * 6)) * 10 * calm; }
        set(el.arm, 'transform', `translate(206 ${302 + breath * 1.2 + dy}) rotate(${a})`);
      }
    }

    function setMood(m) {
      if (!MOODS[m]) m = 'ENGAGED';
      if (m === mood) return;
      mood = m;
      override = null;
      bounceAt = performance.now();
    }

    function say(text, { hold = 4500 } = {}) {
      clearInterval(typer);
      clearTimeout(hideTimer);
      text = String(text || '');
      const step = 38;
      talkUntil = performance.now() + text.length * step + 200;
      if (!bubble) return;
      sayBox.classList.add('on');
      let i = 0;
      sayText.textContent = '';
      typer = setInterval(() => {
        sayText.textContent = text.slice(0, ++i);
        if (i >= text.length) {
          clearInterval(typer);
          hideTimer = setTimeout(() => sayBox.classList.remove('on'), hold);
        }
      }, step);
    }

    function poke() {
      const now = performance.now();
      pokeAt = now;
      override = { mood: 'SYS', until: now + (mood === 'STANDBY' ? 1600 : 1100) };
      say(POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)], { hold: 1800 });
    }

    svg.addEventListener('click', poke);
    addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', onLeave);
    raf = requestAnimationFrame(frame);

    return {
      el: root,
      setMood,
      get mood() { return mood; },
      say,
      poke,
      destroy() {
        cancelAnimationFrame(raf);
        clearInterval(typer);
        clearTimeout(hideTimer);
        removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerleave', onLeave);
        root.remove();
      },
    };
  }

  global.Nova = { create, MOODS: Object.keys(MOODS) };
})(window);
