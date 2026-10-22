// Starting points for an event's custom animation. Each one is a small page of HTML, CSS and SVG that shows on the
// athlete's World page behind the event's words, on every phone with no update.
export interface EventStarter { id: string; label: string; html: string; }

export const EVENT_STARTERS: EventStarter[] = [
  { id: 'logo', label: 'Animated logo', html: `<!-- The Soma Invictus logo, assembling itself on a loop. The page behind it is transparent, so it sits over the event's background. -->
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  .wrap { position: absolute; left: 50%; top: 55px; width: 360px; margin-left: -180px; opacity: .1; color: var(--text); }
  svg { display: block; width: 100%; height: auto; overflow: visible; }
  .piece { --dx: -520px; opacity: 0; transform-box: view-box; transform-origin: 603px 600px; }
  .core { opacity: 0; transform-box: view-box; transform-origin: 603px 705px; }
  .tail { opacity: 0; }
  @keyframes in0{0%,1.25%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(-18deg);animation-timing-function:cubic-bezier(.22,.75,.3,1);} 9.38%{opacity:1;transform:none;} 84.38%{opacity:1;transform:none;animation-timing-function:ease-in-out;} 91.25%,100%{opacity:0;transform:translateY(-16px);}} @keyframes wv0{0%,37.50%{fill-opacity:.72;animation-timing-function:ease-out;} 40.31%{fill-opacity:1;animation-timing-function:ease-in-out;} 45.00%,100%{fill-opacity:.72;}} .p0{animation:in0 16s linear infinite,wv0 16s linear infinite;} @keyframes in1{0%,3.44%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(-18deg);animation-timing-function:cubic-bezier(.22,.75,.3,1);} 11.56%{opacity:1;transform:none;} 82.50%{opacity:1;transform:none;animation-timing-function:ease-in-out;} 89.38%,100%{opacity:0;transform:translateY(-16px);}} @keyframes wv1{0%,39.69%{fill-opacity:.72;animation-timing-function:ease-out;} 42.50%{fill-opacity:1;animation-timing-function:ease-in-out;} 47.19%,100%{fill-opacity:.72;}} .p1{animation:in1 16s linear infinite,wv1 16s linear infinite;} @keyframes in2{0%,5.62%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(-18deg);animation-timing-function:cubic-bezier(.22,.75,.3,1);} 13.75%{opacity:1;transform:none;} 80.62%{opacity:1;transform:none;animation-timing-function:ease-in-out;} 87.50%,100%{opacity:0;transform:translateY(-16px);}} @keyframes wv2{0%,41.88%{fill-opacity:.72;animation-timing-function:ease-out;} 44.69%{fill-opacity:1;animation-timing-function:ease-in-out;} 49.38%,100%{fill-opacity:.72;}} .p2{animation:in2 16s linear infinite,wv2 16s linear infinite;} @keyframes in3{0%,7.81%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(-18deg);animation-timing-function:cubic-bezier(.22,.75,.3,1);} 15.94%{opacity:1;transform:none;} 78.75%{opacity:1;transform:none;animation-timing-function:ease-in-out;} 85.62%,100%{opacity:0;transform:translateY(-16px);}} @keyframes wv3{0%,44.06%{fill-opacity:.72;animation-timing-function:ease-out;} 46.88%{fill-opacity:1;animation-timing-function:ease-in-out;} 51.56%,100%{fill-opacity:.72;}} .p3{animation:in3 16s linear infinite,wv3 16s linear infinite;} @keyframes in4{0%,10.00%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(-18deg);animation-timing-function:cubic-bezier(.22,.75,.3,1);} 18.12%{opacity:1;transform:none;} 76.88%{opacity:1;transform:none;animation-timing-function:ease-in-out;} 83.75%,100%{opacity:0;transform:translateY(-16px);}} @keyframes wv4{0%,46.25%{fill-opacity:.72;animation-timing-function:ease-out;} 49.06%{fill-opacity:1;animation-timing-function:ease-in-out;} 53.75%,100%{fill-opacity:.72;}} .p4{animation:in4 16s linear infinite,wv4 16s linear infinite;} @keyframes core{0%,12.50%{opacity:0;transform:scale(.4);animation-timing-function:cubic-bezier(.2,1.2,.3,1);} 18.12%,48.44%{opacity:1;transform:scale(1);animation-timing-function:ease-in-out;} 51.56%{opacity:1;transform:scale(1.07);animation-timing-function:ease-in-out;} 55.94%,74.38%{opacity:1;transform:scale(1);animation-timing-function:ease-in-out;} 80.62%,100%{opacity:0;transform:translateY(-16px);}} .core{animation:core 16s linear infinite;} @keyframes tail{0%,15.00%{opacity:0;transform:translateY(-90px);animation-timing-function:cubic-bezier(.22,.75,.3,1);} 21.88%,72.50%{opacity:1;transform:none;animation-timing-function:ease-in-out;} 78.75%,100%{opacity:0;transform:translateY(-16px);}} .tail{animation:tail 16s linear infinite;}

</style>
<div class="wrap"><svg viewBox="66 183 1074 786" fill="currentColor" aria-hidden="true">
  <g><polygon class="piece p0" style="--dy:-190px" points="101,191 244,331 284,490 132,360"/><polygon class="piece p1" style="--dy:-90px" points="74,388 196,463 261,597 150,547"/><polygon class="piece p2" style="--dy:60px" points="183,613 345,659 406,734 304,734"/><polygon class="piece p3" style="--dy:150px" points="231,483 382,581 398,687 354,635 291,606"/><polygon class="piece p4" style="--dy:-40px" points="276,358 467,549 455,682 536,821 425,726 403,573 308,478"/></g>
  <g transform="translate(1206,0) scale(-1,1)"><g><polygon class="piece p0" style="--dy:-190px" points="101,191 244,331 284,490 132,360"/><polygon class="piece p1" style="--dy:-90px" points="74,388 196,463 261,597 150,547"/><polygon class="piece p2" style="--dy:60px" points="183,613 345,659 406,734 304,734"/><polygon class="piece p3" style="--dy:150px" points="231,483 382,581 398,687 354,635 291,606"/><polygon class="piece p4" style="--dy:-40px" points="276,358 467,549 455,682 536,821 425,726 403,573 308,478"/></g></g>
  <path class="core" fill-rule="evenodd" d="M603,524 L721,683 L603,887 L485,683 Z M603,578 L682,685 L603,817 L524,685 Z"/>
  <polygon class="tail" points="519,830 603,961 687,830 629,872 603,911 577,872"/>
</svg></div>` },
  { id: 'orbs', label: 'Drifting light', html: `<!-- HTML, CSS and SVG, with CSS animations or SVG animation. No JavaScript: scripts are blocked. The page is transparent and
     sits behind the event's words. --accent is the athlete's rank color and --text is the text color. -->
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  .orb { position: absolute; border-radius: 50%; background: var(--accent); opacity: .16; filter: blur(30px); animation: drift 14s ease-in-out infinite alternate; }
  .a { width: 220px; height: 220px; left: -40px; top: 40px; }
  .b { width: 280px; height: 280px; right: -80px; top: 150px; animation-duration: 19s; animation-delay: -6s; }
  @keyframes drift { from { transform: translate(0, 0) scale(1); } to { transform: translate(60px, 40px) scale(1.25); } }
</style>
<div class="orb a"></div><div class="orb b"></div>` }
];

// How a custom animation is put in a page: transparent, filling the hero, with no JavaScript. The frame is sandboxed with
// every permission off, and the page forbids scripts and any request but images, so what is written here can never run
// code on an athlete's phone. CSS animations and SVG animation run as normal. --accent is the athlete's rank color.
export function eventDoc(html: string, accent: string, text = '#eaf2f8'): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https:; font-src data:">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>:root{--accent:' + accent + ';--text:' + text + ';color-scheme:normal}html,body{margin:0;background:transparent}</style></head><body>'
    + html + '</body></html>';
}
