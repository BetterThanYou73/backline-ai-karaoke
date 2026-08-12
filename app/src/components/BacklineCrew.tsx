"use client";

import type { StyleSkin } from "@/lib/styles";

/**
 * The Backline crew, drawn as SVG rather than shipped as art.
 *
 * One rig, six reskins, exactly as the brief asks for. The shapes are shared
 * between every skin: three figures on a small stage, differing only in head
 * silhouette, palette and props. That keeps the whole cast to one file and
 * means a new style is a colour entry, not an art commission.
 *
 * `energy` (0 to 1) and `accuracy` (0 to 1) drive the reaction: the crew rises
 * and leans with energy, and the glow behind them warms up as accuracy climbs.
 * No flashing, no strobing, per the accessibility note in the brief.
 */

interface CrewProps {
  skin: StyleSkin;
  energy?: number;
  accuracy?: number;
  /** Seconds since the take started, used for idle sway. */
  time?: number;
  className?: string;
}

type HeadRenderer = (x: number, y: number, scale: number) => React.ReactElement;

// React 19's types dropped the global JSX namespace, so the return type is
// spelled out rather than relying on JSX.Element.
const HEADS: Record<StyleSkin["crew"], HeadRenderer> = {
  robot: (x, y, s) => (
    <g>
      <rect x={x - 11 * s} y={y - 12 * s} width={22 * s} height={20 * s} rx={4 * s} />
      <rect x={x - 1.5 * s} y={y - 20 * s} width={3 * s} height={8 * s} rx={1.5 * s} />
      <circle cx={x} cy={y - 21 * s} r={2.5 * s} />
    </g>
  ),
  band: (x, y, s) => (
    <g>
      <circle cx={x} cy={y - 4 * s} r={11 * s} />
      <rect x={x - 15 * s} y={y - 14 * s} width={30 * s} height={3 * s} rx={1.5 * s} />
      <rect x={x - 9 * s} y={y - 22 * s} width={18 * s} height={9 * s} rx={2 * s} />
    </g>
  ),
  roadie: (x, y, s) => (
    <g>
      <circle cx={x} cy={y - 4 * s} r={11 * s} />
      <path
        d={`M ${x - 12 * s} ${y - 9 * s} q ${12 * s} ${-10 * s} ${24 * s} 0 z`}
      />
      <rect x={x - 13 * s} y={y - 10 * s} width={26 * s} height={3 * s} rx={1.5 * s} />
    </g>
  ),
  deckhand: (x, y, s) => (
    <g>
      <circle cx={x} cy={y - 4 * s} r={11 * s} />
      <path d={`M ${x - 13 * s} ${y - 11 * s} h ${26 * s} l ${-5 * s} ${-7 * s} h ${-16 * s} z`} />
    </g>
  ),
  spirit: (x, y, s) => (
    <g>
      <circle cx={x} cy={y - 4 * s} r={11 * s} />
      <path d={`M ${x - 7 * s} ${y - 13 * s} q ${3 * s} ${-9 * s} ${8 * s} ${-6 * s}`} fill="none" strokeWidth={2.5 * s} />
      <path d={`M ${x + 6 * s} ${y - 13 * s} q ${-2 * s} ${-8 * s} ${-6 * s} ${-7 * s}`} fill="none" strokeWidth={2.5 * s} />
    </g>
  ),
  glam: (x, y, s) => (
    <g>
      <circle cx={x} cy={y - 4 * s} r={11 * s} />
      <path
        d={`M ${x - 12 * s} ${y - 8 * s} q ${2 * s} ${-14 * s} ${12 * s} ${-13 * s} q ${10 * s} ${-1 * s} ${12 * s} ${13 * s} q ${-6 * s} ${-6 * s} ${-12 * s} ${-5 * s} q ${-6 * s} ${-1 * s} ${-12 * s} ${5 * s} z`}
      />
    </g>
  ),
};

function Figure({
  x,
  scale,
  bounce,
  lean,
  skin,
}: {
  x: number;
  scale: number;
  bounce: number;
  lean: number;
  skin: StyleSkin;
}) {
  const baseline = 150;
  const y = baseline - bounce;
  const head = HEADS[skin.crew];

  return (
    <g transform={`rotate(${lean} ${x} ${baseline})`}>
      {/* body */}
      <path
        d={`M ${x - 13 * scale} ${y} q ${13 * scale} ${-8 * scale} ${26 * scale} 0 l ${-3 * scale} ${28 * scale} h ${-20 * scale} z`}
        fill={skin.body}
      />
      {/* arms */}
      <rect
        x={x - 20 * scale}
        y={y + 2 * scale}
        width={7 * scale}
        height={20 * scale}
        rx={3.5 * scale}
        fill={skin.body}
      />
      <rect
        x={x + 13 * scale}
        y={y + 2 * scale}
        width={7 * scale}
        height={20 * scale}
        rx={3.5 * scale}
        fill={skin.body}
      />
      {/* head, in trim colour so the silhouette reads at small sizes */}
      <g fill={skin.trim} stroke={skin.trim} strokeLinejoin="round">
        {head(x, y, scale)}
      </g>
      {/* eyes */}
      <circle cx={x - 4 * scale} cy={y - 5 * scale} r={1.7 * scale} fill={skin.body} />
      <circle cx={x + 4 * scale} cy={y - 5 * scale} r={1.7 * scale} fill={skin.body} />
    </g>
  );
}

export function BacklineCrew({
  skin,
  energy = 0.35,
  accuracy = 0.6,
  time = 0,
  className,
}: CrewProps) {
  const clampedEnergy = Math.max(0, Math.min(1, energy));
  const clampedAccuracy = Math.max(0, Math.min(1, accuracy));

  // Idle sway even at rest, so the crew never looks frozen. Each figure is
  // offset in phase so they are not a rigid chorus line.
  const beat = (phase: number) =>
    Math.max(0, Math.sin(time * 3.2 + phase)) * (4 + clampedEnergy * 22);

  const glow = 0.15 + clampedAccuracy * 0.5;

  return (
    <svg
      viewBox="0 0 320 200"
      className={className}
      role="img"
      aria-label={`${skin.label}, the ${skin.vibe.toLowerCase()}`}
    >
      <defs>
        <linearGradient id={`bg-${skin.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={skin.gradient[0]} />
          <stop offset="100%" stopColor={skin.gradient[1]} />
        </linearGradient>
        <radialGradient id={`glow-${skin.id}`} cx="50%" cy="72%" r="55%">
          <stop offset="0%" stopColor={skin.accent} stopOpacity={glow} />
          <stop offset="100%" stopColor={skin.accent} stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="320" height="200" fill={`url(#bg-${skin.id})`} />
      <ellipse cx="160" cy="150" rx="150" ry="70" fill={`url(#glow-${skin.id})`} />

      {/* stage floor */}
      <rect x="20" y="176" width="280" height="4" rx="2" fill={skin.accent} opacity="0.35" />

      <Figure x={80} scale={0.85} bounce={beat(0)} lean={Math.sin(time * 1.6) * 2} skin={skin} />
      <Figure x={160} scale={1} bounce={beat(1.9)} lean={Math.sin(time * 1.6 + 1) * 2} skin={skin} />
      <Figure x={240} scale={0.85} bounce={beat(3.6)} lean={Math.sin(time * 1.6 + 2) * 2} skin={skin} />
    </svg>
  );
}
