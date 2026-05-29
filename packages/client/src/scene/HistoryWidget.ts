import { Container, Text, type TextOptions } from "pixi.js";
import { COURT_WIDTH, type MatchSummary, type UserSummary } from "@pingpong/shared";
import { SERVER_HOST } from "../env";

const FONT = "'Courier New', Courier, monospace";
const TEXT_WHITE = 0xff_ff_ff;
const TEXT_DIM = 0x88_99_aa;
const WIN_GREEN = 0x4c_af_50;
const LOSS_RED = 0xff_7a_7a;
const MAX_ROWS = 5;
const ROW_HEIGHT = 28;
const WIDGET_WIDTH = COURT_WIDTH - 40;

function makeText(
  opts: Pick<TextOptions, "text" | "style"> & { label?: string },
): Text {
  const t = new Text(opts);
  if (opts.label) t.label = opts.label;
  return t;
}

function timeAgo(startedAtMs: number): string {
  const sec = Math.floor((Date.now() - startedAtMs) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

interface HistoryMatch extends MatchSummary {
  startedAt: number;
}

export interface HistoryWidgetNode {
  readonly container: Container;
  load(accessToken: string, userId: string): Promise<void>;
  setVisible(visible: boolean): void;
}

export function buildHistoryWidget(): HistoryWidgetNode {
  const container = new Container();
  container.label = "historyWidget";
  container.x = 20;
  container.y = 20;

  const header = makeText({
    text: "Recent matches",
    label: "historyHeader",
    style: {
      fontFamily: FONT,
      fontSize: 22,
      fill: TEXT_WHITE,
      fontWeight: "bold",
    },
  });
  container.addChild(header);

  const emptyText = makeText({
    text: "No matches yet — play your first!",
    label: "historyEmpty",
    style: { fontFamily: FONT, fontSize: 16, fill: TEXT_DIM },
  });
  emptyText.y = 30;
  emptyText.visible = false;
  container.addChild(emptyText);

  const rowsContainer = new Container();
  rowsContainer.label = "historyRows";
  rowsContainer.y = 30;
  container.addChild(rowsContainer);

  async function load(accessToken: string, userId: string): Promise<void> {
    rowsContainer.removeChildren();
    emptyText.visible = false;

    try {
      const res = await fetch(
        `${SERVER_HOST}/api/matches?userId=${encodeURIComponent(userId)}&limit=${MAX_ROWS}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as { matches: HistoryMatch[] };
      const { matches } = data;

      if (matches.length === 0) {
        emptyText.visible = true;
        return;
      }

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        if (!match) continue;
        const row = buildMatchRow(match, userId);
        row.y = i * ROW_HEIGHT;
        rowsContainer.addChild(row);
      }
    } catch (err) {
    }
  }

  function setVisible(visible: boolean): void {
    container.visible = visible;
  }

  return { container, load, setVisible };
}

function buildMatchRow(match: HistoryMatch, currentUserId: string): Container {
  const row = new Container();

  const isBottom = match.players.bottom.id === currentUserId;
  const mySlot: "top" | "bottom" = isBottom ? "bottom" : "top";
  const won = match.winner === mySlot;

  const opponent: UserSummary =
    mySlot === "bottom" ? match.players.top : match.players.bottom;

  const myScore = match.score[mySlot];
  const theirScore = match.score[mySlot === "bottom" ? "top" : "bottom"];

  const badge = makeText({
    text: won ? "W" : "L",
    style: {
      fontFamily: FONT,
      fontSize: 16,
      fill: won ? WIN_GREEN : LOSS_RED,
      fontWeight: "bold",
    },
  });
  badge.x = 0;
  row.addChild(badge);

  const scoreText = makeText({
    text: `${myScore}-${theirScore}`,
    style: { fontFamily: FONT, fontSize: 16, fill: TEXT_WHITE },
  });
  scoreText.x = 24;
  row.addChild(scoreText);

  const opponentText = makeText({
    text: opponent.username,
    style: { fontFamily: FONT, fontSize: 16, fill: TEXT_DIM },
  });
  opponentText.x = 90;
  row.addChild(opponentText);

  const agoText = makeText({
    text: timeAgo(match.startedAt),
    style: { fontFamily: FONT, fontSize: 14, fill: TEXT_DIM },
  });
  agoText.x = WIDGET_WIDTH - 100;
  row.addChild(agoText);

  return row;
}
