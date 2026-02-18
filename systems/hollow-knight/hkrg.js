// systems/hollow-knight/hkrg.js
// Foundry VTT v13 — HKRPG core logic (RU)

// ----------------------------
// Small utilities
// ----------------------------
const SYS_ID = "hollow-knight";

function i18n(key, data) {
  return game.i18n.format(key, data ?? {});
}

function warnChat(actor, titleKey, messageKey, data = {}) {
  const title = i18n(titleKey, data);
  const msg = i18n(messageKey, data);
  ui.notifications.warn(`${actor?.name ?? ""}: ${title} — ${msg}`);

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="hkrpg chat-warning">
        <h3>${title}</h3>
        <p>${msg}</p>
      </div>
    `
  });
}

function infoChat(actor, title, html) {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="hkrpg chat-info">
        <h3>${title}</h3>
        ${html ?? ""}
      </div>
    `
  });
}

function getActorFromControlledToken() {
  const token = canvas?.tokens?.controlled?.[0];
  return token?.actor ?? null;
}

function clampInt(n, min, max) {
  n = parseInt(n ?? 0, 10);
  if (Number.isNaN(n)) n = 0;
  return Math.max(min, Math.min(max, n));
}

function getStamina(actor) {
  const value = actor?.system?.pools?.stamina?.value ?? 0;
  const max = actor?.system?.pools?.stamina?.max ?? 0;
  return { value, max };
}

async function setStamina(actor, value) {
  return actor.update({ "system.pools.stamina.value": value });
}

// Flags: per-turn stamina tax tracking
function getTurnTax(actor) {
  return act
