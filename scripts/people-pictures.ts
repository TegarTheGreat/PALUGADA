/**
 * Draws the twelve pictures a person chooses from (F19.2):
 * `console/public/avatars/people/person-01.webp` to `person-12.webp`, 256
 * pixels square, as `brand/README.md` describes.
 *
 * Each is a person drawn from shapes -- a face, hair, clothes, a soft light
 * from above -- in the colours of the owner's picture, so the people and the
 * owner read as one family and none of them as the agent. Twelve different
 * people, so a room of colleagues is told apart at a glance. Run by hand, and
 * the pictures committed: rendered by the platform's own Chromium driver, so
 * nothing is added to draw them.
 *
 *   node scripts/people-pictures.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Cdp } from '../src/browser/cdp.ts';
import { findChromium } from '../src/browser/chromium.ts';

const OUT = fileURLToPath(new URL('../console/public/avatars/people/', import.meta.url));
const SIZE = 256;

type Hair = 'long' | 'short' | 'bob' | 'curly' | 'bun' | 'side' | 'swept' | 'fringe' | 'wavy' | 'shaved' | 'afro';

interface Person {
  /** The background, from its light middle to its edge. */
  ground: [string, string];
  skin: [string, string];
  hair: Hair | 'hijab';
  hairColour: [string, string];
  top: [string, string];
  /** What sits at the neck: a round collar, a V, a shirt collar, or a hood. */
  neckline: 'round' | 'v' | 'collar' | 'hood';
  glasses?: true;
  beard?: 'full' | 'stubble';
  headband?: string;
  earrings?: true;
}

const PEOPLE: Person[] = [
  { ground: ['#e6f7f0', '#bfe8d8'], skin: ['#f3c9a8', '#d9a07c'], hair: 'long', hairColour: ['#3a2a24', '#1f1512'], top: ['#3fb8a5', '#22897a'], neckline: 'round', earrings: true },
  { ground: ['#e5f1fd', '#bcd8f6'], skin: ['#c98d62', '#a4683f'], hair: 'short', hairColour: ['#262020', '#100c0c'], top: ['#3b4f8f', '#25336a'], neckline: 'collar', glasses: true },
  { ground: ['#fdeee6', '#f7cdb8'], skin: ['#dfa883', '#bd8058'], hair: 'hijab', hairColour: ['#d9798f', '#b45468'], top: ['#f4ead9', '#d9c9ad'], neckline: 'round' },
  { ground: ['#fdf6dc', '#f4e19c'], skin: ['#8a5536', '#64391f'], hair: 'curly', hairColour: ['#2a1a14', '#140c09'], top: ['#e2a832', '#bb8419'], neckline: 'round', beard: 'full' },
  { ground: ['#f2ecfd', '#d9cbf7'], skin: ['#f6d3bc', '#dcac8d'], hair: 'bob', hairColour: ['#a4482b', '#7a2f17'], top: ['#ef7b6a', '#cf5646'], neckline: 'v' },
  { ground: ['#eaf4e6', '#c6dfbd'], skin: ['#d9a982', '#b78259'], hair: 'side', hairColour: ['#b8b4b0', '#8e8a86'], top: ['#5c9a5a', '#3f773d'], neckline: 'v', glasses: true },
  { ground: ['#fff0e0', '#fbd2a8'], skin: ['#6e412a', '#4f2b19'], hair: 'afro', hairColour: ['#2a1b15', '#130b08'], top: ['#f08a3c', '#cf6a1f'], neckline: 'round', headband: '#f5c542', earrings: true },
  { ground: ['#e9ecfd', '#c4cbf6'], skin: ['#f7d6c0', '#ddb092'], hair: 'swept', hairColour: ['#d9b35f', '#b38c3a'], top: ['#4a7fd6', '#2f5fb3'], neckline: 'hood' },
  { ground: ['#fdeaf3', '#f6c6dc'], skin: ['#c99470', '#a8704b'], hair: 'bun', hairColour: ['#1f1715', '#0d0908'], top: ['#7f5ad8', '#5f3db6'], neckline: 'v', glasses: true },
  { ground: ['#e3f6f8', '#b6e3ea'], skin: ['#a4693f', '#7f4a25'], hair: 'shaved', hairColour: ['#2b1d16', '#1a110c'], top: ['#2aa3b6', '#178093'], neckline: 'collar', beard: 'stubble' },
  { ground: ['#f8f1e6', '#e9d6b9'], skin: ['#f4d2b4', '#dbab88'], hair: 'fringe', hairColour: ['#1d1a1c', '#0b090a'], top: ['#d9474f', '#b02d35'], neckline: 'round' },
  { ground: ['#e9eef4', '#c6d1df'], skin: ['#dcab84', '#bc855c'], hair: 'wavy', hairColour: ['#6b4430', '#4a2b1b'], top: ['#9b3b5a', '#782541'], neckline: 'round' },
];

/** A linear gradient from the light to the shade, lit from the upper left, as the owner's picture is. */
const lit = (id: string, [light, shade]: [string, string]) =>
  `<linearGradient id="${id}" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${shade}"/></linearGradient>`;

function hairBehind(person: Person): string {
  switch (person.hair) {
    case 'long':
      return '<path d="M74 104 C70 54 186 54 182 104 L190 196 C170 214 86 214 66 196 Z" fill="url(#hair)"/>';
    case 'bob':
      return '<path d="M74 106 C68 52 188 52 182 106 L186 160 C176 172 80 172 70 160 Z" fill="url(#hair)"/>';
    case 'afro':
      return '<circle cx="128" cy="96" r="70" fill="url(#hair)"/><circle cx="74" cy="118" r="26" fill="url(#hair)"/><circle cx="182" cy="118" r="26" fill="url(#hair)"/>';
    case 'curly':
      return '<g fill="url(#hair)"><circle cx="92" cy="74" r="20"/><circle cx="114" cy="62" r="21"/><circle cx="140" cy="62" r="21"/><circle cx="164" cy="74" r="20"/><circle cx="80" cy="96" r="15"/><circle cx="176" cy="96" r="15"/></g>';
    case 'bun':
      return '<circle cx="128" cy="44" r="22" fill="url(#hair)"/><path d="M80 104 C76 58 180 58 176 104 Z" fill="url(#hair)"/>';
    case 'wavy':
      return '<path d="M76 110 C66 50 190 50 180 110 C186 124 176 132 172 126 L84 126 C80 132 70 124 76 110 Z" fill="url(#hair)"/>';
    case 'hijab':
      return '<path d="M128 50 C80 50 70 92 72 128 C74 160 82 178 96 190 L160 190 C174 178 182 160 184 128 C186 92 176 50 128 50 Z" fill="url(#hair)"/>';
    case 'fringe':
      return '<path d="M74 100 C70 52 186 52 182 100 L184 180 C170 186 86 186 72 180 Z" fill="url(#hair)"/>';
    default:
      return '';
  }
}

/** A hijab's drape, over the clothes and under the chin, so it covers the neck and the shoulders' top as one is worn. */
function drape(person: Person): string {
  if (person.hair !== 'hijab') return '';
  return '<path d="M84 150 C80 176 64 196 58 222 C88 240 168 240 198 222 C192 196 176 176 172 150 C164 170 148 182 128 182 C108 182 92 170 84 150 Z" fill="url(#hair)"/>'
    + '<path d="M78 200 C100 214 156 214 178 200" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.18"/>';
}

function hairFront(person: Person): string {
  switch (person.hair) {
    case 'long':
      return '<path d="M82 100 C84 62 120 52 150 60 C170 66 178 84 176 100 C160 82 132 76 110 86 C98 92 88 98 82 100 Z" fill="url(#hair)"/>';
    case 'short':
      return '<path d="M84 98 C80 60 116 50 140 54 C166 58 178 76 174 98 C164 80 150 74 128 74 C108 74 92 82 84 98 Z" fill="url(#hair)"/>';
    case 'bob':
      return '<path d="M82 104 C80 66 116 56 136 58 C162 60 178 80 176 104 C164 84 128 72 82 104 Z" fill="url(#hair)"/>';
    case 'curly':
      return '<g fill="url(#hair)"><circle cx="100" cy="80" r="13"/><circle cx="120" cy="74" r="13"/><circle cx="140" cy="74" r="13"/><circle cx="158" cy="82" r="12"/></g>';
    case 'bun':
      return '<path d="M84 100 C86 70 112 60 128 60 C148 60 172 70 172 100 C158 84 140 78 128 78 C114 78 96 84 84 100 Z" fill="url(#hair)"/>';
    case 'side':
      return '<path d="M84 100 C82 70 104 56 132 56 C160 56 176 72 174 100 C168 86 160 80 150 78 C130 76 110 70 100 76 C92 80 88 90 84 100 Z" fill="url(#hair)"/>';
    case 'swept':
      return '<path d="M84 98 C78 62 108 46 140 50 C170 54 184 74 172 98 C170 84 160 74 140 72 C120 70 102 80 84 98 Z" fill="url(#hair)"/><path d="M104 62 C124 50 156 52 170 66" stroke="#f0d48c" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.6"/>';
    case 'fringe':
      return '<path d="M82 106 C76 46 180 46 174 106 C166 98 158 101 150 96 C142 101 134 98 126 96 C118 101 110 98 102 96 C94 101 88 102 82 106 Z" fill="url(#hair)"/>'
        + '<path d="M104 70 C120 62 146 62 160 70" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.18"/>';
    case 'wavy':
      return '<path d="M84 102 C80 66 110 54 132 56 C158 58 176 74 174 100 C166 88 156 82 146 86 C136 76 120 78 112 86 C100 82 90 90 84 102 Z" fill="url(#hair)"/>';
    case 'shaved':
      return '<path d="M86 92 C88 64 112 56 128 56 C146 56 168 64 170 92 C156 78 100 78 86 92 Z" fill="url(#hair)" opacity="0.55"/>';
    case 'afro':
      return '<path d="M86 98 C88 70 112 62 128 62 C146 62 168 70 170 98 C150 84 106 84 86 98 Z" fill="url(#hair)"/>';
    case 'hijab':
      // A band framing the face: everything between an outer oval and the face's own.
      return '<path fill-rule="evenodd" fill="url(#hair)" d="M128 52 C90 52 72 84 72 118 C72 152 92 182 128 184 C164 182 184 152 184 118 C184 84 166 52 128 52 Z'
        + ' M128 78 C104 78 90 98 90 122 C90 148 106 166 128 166 C150 166 166 148 166 122 C166 98 152 78 128 78 Z"/>'
        + '<path d="M96 66 C112 56 144 56 160 66" stroke="#ffffff" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.25"/>';
    default:
      return '';
  }
}

function neckline(person: Person): string {
  switch (person.neckline) {
    case 'v':
      return '<path d="M110 178 L128 206 L146 178" fill="url(#skin)" stroke="url(#topEdge)" stroke-width="5" stroke-linejoin="round"/>';
    case 'collar':
      return '<path d="M108 176 L128 200 L118 214 L98 186 Z" fill="#ffffff" opacity="0.92"/><path d="M148 176 L128 200 L138 214 L158 186 Z" fill="#ffffff" opacity="0.92"/>';
    case 'hood':
      return '<path d="M86 186 C96 170 112 176 128 192 C144 176 160 170 170 186 C160 204 96 204 86 186 Z" fill="url(#topEdge)" opacity="0.9"/>'
        + '<path d="M118 200 L116 226 M138 200 L140 226" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.8"/>';
    default:
      return '<path d="M106 178 C112 190 144 190 150 178" fill="none" stroke="url(#topEdge)" stroke-width="6" stroke-linecap="round"/>';
  }
}

function face(person: Person): string {
  const parts = [
    // Eyes, each with a glint, and brows.
    '<ellipse cx="111" cy="116" rx="5.2" ry="6.8" fill="#140c0a"/><ellipse cx="145" cy="116" rx="5.2" ry="6.8" fill="#140c0a"/>',
    '<circle cx="113" cy="113.3" r="2.1" fill="#ffffff"/><circle cx="147" cy="113.3" r="2.1" fill="#ffffff"/>',
    `<path d="M102 102 Q111 97 119 101 M137 101 Q145 97 154 102" stroke="${person.hair === 'hijab' ? '#3a2a24' : person.hairColour[1]}" stroke-width="3.2" fill="none" stroke-linecap="round" opacity="0.85"/>`,
    // Cheeks and a smile.
    '<ellipse cx="101" cy="132" rx="8" ry="5" fill="#ff8a8a" opacity="0.22"/><ellipse cx="155" cy="132" rx="8" ry="5" fill="#ff8a8a" opacity="0.22"/>',
    '<path d="M115 138 Q128 149 141 138" stroke="#7a3b2e" stroke-width="3.4" fill="none" stroke-linecap="round"/>',
  ];
  if (person.beard === 'full') {
    parts.push('<path d="M86 118 C86 160 106 172 128 172 C150 172 170 160 170 118 C164 140 154 150 146 146 C138 142 118 142 110 146 C102 150 92 140 86 118 Z" fill="url(#hair)"/>'
      + '<path d="M115 139 Q128 148 141 139" stroke="#f4e3d8" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.9"/>');
  }
  if (person.beard === 'stubble') {
    parts.push('<path d="M88 124 C90 158 108 170 128 170 C148 170 166 158 168 124 C160 146 146 154 128 154 C110 154 96 146 88 124 Z" fill="url(#hair)" opacity="0.35"/>');
  }
  if (person.glasses) {
    parts.push('<g fill="none" stroke="#2a2a3a" stroke-width="3"><rect x="96" y="104" width="30" height="24" rx="9"/><rect x="130" y="104" width="30" height="24" rx="9"/>'
      + '<path d="M126 112 Q128 109 130 112"/><path d="M96 112 L86 108 M160 112 L170 108"/></g>'
      + '<rect x="99" y="107" width="10" height="4" rx="2" fill="#ffffff" opacity="0.35"/><rect x="133" y="107" width="10" height="4" rx="2" fill="#ffffff" opacity="0.35"/>');
  }
  return parts.join('');
}

function svg(person: Person): string {
  const ears = person.hair === 'hijab' ? ''
    : '<ellipse cx="83" cy="122" rx="9" ry="13" fill="url(#skin)"/><ellipse cx="173" cy="122" rx="9" ry="13" fill="url(#skin)"/>'
      + (person.earrings ? '<circle cx="82" cy="138" r="4" fill="#f5c542"/><circle cx="174" cy="138" r="4" fill="#f5c542"/>' : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 256 256">
<defs>
<radialGradient id="ground" cx="0.42" cy="0.32" r="0.85"><stop offset="0" stop-color="${person.ground[0]}"/><stop offset="1" stop-color="${person.ground[1]}"/></radialGradient>
${lit('skin', person.skin)}${lit('hair', person.hairColour)}${lit('top', person.top)}
<linearGradient id="topEdge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${person.top[1]}"/><stop offset="1" stop-color="${person.top[1]}"/></linearGradient>
<radialGradient id="shine" cx="0.35" cy="0.3" r="0.6"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="6"/><feOffset dy="6"/><feComponentTransfer><feFuncA type="linear" slope="0.18"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="256" height="256" fill="url(#ground)"/>
<g filter="url(#soft)">
${hairBehind(person)}
<path d="M40 256 C40 206 72 182 128 180 C184 182 216 206 216 256 Z" fill="url(#top)"/>
<path d="M60 236 C74 206 98 194 128 192" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.18"/>
${person.hair === 'hijab' ? '' : `<path d="M112 150 L112 182 C118 192 138 192 144 182 L144 150 Z" fill="url(#skin)"/>
<path d="M112 168 C120 176 136 176 144 168 L144 160 C136 168 120 168 112 160 Z" fill="#000000" opacity="0.08"/>
${neckline(person)}`}
${drape(person)}
${ears}
<ellipse cx="128" cy="118" rx="45" ry="52" fill="url(#skin)"/>
<ellipse cx="128" cy="118" rx="45" ry="52" fill="url(#shine)"/>
${face(person)}
${hairFront(person)}
${person.headband ? `<path d="M84 90 C100 70 156 70 172 90" stroke="${person.headband}" stroke-width="8" fill="none" stroke-linecap="round"/>` : ''}
</g>
</svg>`;
}

const executable = findChromium(process.env);
if (!executable) {
  console.error('no Chromium here to draw with: install one, or set PALUGADA_CHROMIUM to it');
  process.exit(1);
}
await mkdir(OUT, { recursive: true });
const cdp = await Cdp.launch(executable, { sandbox: false });
try {
  for (const [index, person] of PEOPLE.entries()) {
    const page = `<!doctype html><html><body style="margin:0;background:transparent">${svg(person)}</body></html>`;
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: `data:text/html;base64,${Buffer.from(page).toString('base64')}`,
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false }, sessionId);
    for (let tries = 0; tries < 50; tries += 1) {
      const ready = await cdp.send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
      if (ready.result.value === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'webp', quality: 92, clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 },
    }, sessionId);
    const name = `person-${String(index + 1).padStart(2, '0')}.webp`;
    await writeFile(`${OUT}${name}`, Buffer.from(shot.data, 'base64'));
    await cdp.send('Target.closeTarget', { targetId });
    console.log(`drew ${name}`);
  }
} finally {
  await cdp.close();
}
