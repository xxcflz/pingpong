import { Container, Graphics, Text } from "pixi.js";
import { COURT_WIDTH, COURT_HEIGHT } from "@pingpong/shared";

const FONT = "'Courier New', Courier, monospace";
const TEXT_WHITE = 0xff_ff_ff;
const TEXT_DIM = 0x88_99_aa;
const ACCENT_GOLD = 0xff_d7_00;
const ACCENT_BLUE = 0x4d_d2_ff;
const ACCENT_GREEN = 0x5e_aa_8a;
const OVERLAY_BG = 0x00_00_00;

export interface EndScreenData {
  end_reason: string;
  winnerName: string;
  loserName: string;
  scoreA: number;
  scoreB: number;
  rallyCountMax: number;
  winnerSlot: string | null;
  onRematch: () => void;
  onReturnToLobby: () => void;
}

export interface EndScreenNode {
  readonly container: Container;
  update(dtMs: number): void;
  setWaitingText(text: string): void;
}

export function buildEndScreen(data: EndScreenData): EndScreenNode {
  const container = new Container();
  container.label = "endScreen";

  const overlay = new Graphics()
    .rect(0, 0, COURT_WIDTH, COURT_HEIGHT)
    .fill({ color: OVERLAY_BG, alpha: 0.75 });
  container.addChild(overlay);

  const headline = buildHeadline(data);
  container.addChild(headline);

  const subtitle = buildSubtitle(data);
  container.addChild(subtitle);

  const waitingText = new Text({
    text: "",
    style: {
      fontFamily: FONT,
      fontSize: 16,
      fill: TEXT_DIM,
    },
  });
  waitingText.anchor.set(0.5);
  waitingText.x = COURT_WIDTH / 2;
  waitingText.y = COURT_HEIGHT / 2 + 100;
  container.addChild(waitingText);

  // Buttons
  const btnW = 200;
  const btnH = 50;
  const btnY = COURT_HEIGHT / 2 + 150;
  const btnGap = 40;

  // Rematch button (left)
  const rematchBtn = new Graphics()
    .roundRect(0, 0, btnW, btnH, 8)
    .fill(ACCENT_BLUE);
  rematchBtn.x = COURT_WIDTH / 2 - btnW - btnGap / 2;
  rematchBtn.y = btnY;
  rematchBtn.eventMode = "static";
  rematchBtn.cursor = "pointer";
  rematchBtn.on("pointertap", data.onRematch);
  container.addChild(rematchBtn);

  const rematchText = new Text({
    text: "REMATCH",
    style: {
      fontFamily: FONT,
      fontSize: 20,
      fontWeight: "bold",
      fill: TEXT_WHITE,
    },
  });
  rematchText.anchor.set(0.5);
  rematchText.x = btnW / 2;
  rematchText.y = btnH / 2;
  rematchBtn.addChild(rematchText);

  // Return to lobby button (right)
  const lobbyBtn = new Graphics()
    .roundRect(0, 0, btnW, btnH, 8)
    .fill(ACCENT_GREEN);
  lobbyBtn.x = COURT_WIDTH / 2 + btnGap / 2;
  lobbyBtn.y = btnY;
  lobbyBtn.eventMode = "static";
  lobbyBtn.cursor = "pointer";
  lobbyBtn.on("pointertap", data.onReturnToLobby);
  container.addChild(lobbyBtn);

  const lobbyText = new Text({
    text: "RETURN TO LOBBY",
    style: {
      fontFamily: FONT,
      fontSize: 18,
      fontWeight: "bold",
      fill: TEXT_WHITE,
    },
  });
  lobbyText.anchor.set(0.5);
  lobbyText.x = btnW / 2;
  lobbyText.y = btnH / 2;
  lobbyBtn.addChild(lobbyText);

  return {
    container,
    update() {
      // No auto-expire — user controls timing via buttons
    },
    setWaitingText(text: string) {
      waitingText.text = text;
    },
  };
}

function buildHeadline(data: EndScreenData): Text {
  let text: string;

  switch (data.end_reason) {
    case "score":
      text = `${data.winnerName} wins ${data.scoreA}-${data.scoreB}`;
      break;
    case "forfeit_dc":
      text = `${data.winnerName} wins (${data.loserName} disconnected)`;
      break;
    case "forfeit_afk":
      text = `${data.winnerName} wins (${data.loserName} was AFK)`;
      break;
    default:
      text = `${data.winnerName} wins`;
  }

  const label = new Text({
    text,
    style: {
      fontFamily: FONT,
      fontSize: 36,
      fill: ACCENT_GOLD,
      fontWeight: "bold",
      align: "center",
      wordWrap: true,
      wordWrapWidth: COURT_WIDTH - 60,
    },
  });
  label.anchor.set(0.5);
  label.x = COURT_WIDTH / 2;
  label.y = COURT_HEIGHT / 2 - 50;
  return label;
}

function buildSubtitle(data: EndScreenData): Text {
  let text: string;

  if (data.end_reason === "score" && data.rallyCountMax > 0) {
    text = `Longest rally: ${data.rallyCountMax}`;
  } else if (data.end_reason === "forfeit_dc") {
    text = `${data.scoreA}-${data.scoreB}`;
  } else if (data.end_reason === "forfeit_afk") {
    text = `${data.scoreA}-${data.scoreB}`;
  } else {
    text = `${data.scoreA}-${data.scoreB}`;
  }

  const label = new Text({
    text,
    style: {
      fontFamily: FONT,
      fontSize: 22,
      fill: TEXT_WHITE,
      align: "center",
    },
  });
  label.anchor.set(0.5);
  label.x = COURT_WIDTH / 2;
  label.y = COURT_HEIGHT / 2 + 10;
  return label;
}
