/* global ActorSheet, ItemSheet, game, ui, Hooks, ChatMessage, Roll, foundry, Dialog, canvas */

const SYS_ID = "hollow-knight";

function t(key, data) {
  return game.i18n.format(key, data ?? {});
}

async function postMisuse(actor, reasonKey, data) {
  const msg = t(reasonKey, data);
  ui.notifications.warn(msg);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="hkrpg-warn"><b>${t("HKRPG.Chat.MisuseTitle")}</b>: ${msg}</div>`
  });
}

function getControlledActor() {
  return canvas?.tokens?.controlled?.[0]?.actor ?? null;
}

function isMyTurn(actor) {
  const combat = game.combat;
  if (!combat) return true;
  const current = combat.combatant?.actor;
  return current?.id === actor.id;
}

function getEquippedWeapons(actor) {
  return actor.items.filter(i => i.type === "weapon" && i.system?.equipped);
}

function getMaxWeaponInitiativeBonus(actor) {
  const weapons = getEquippedWeapons(actor);
  return weapons.reduce((m, w) => Math.max(m, Number(w.system?.initiativeBonus?.value ?? 0)), 0);
}

async function spendResource(actor, path, amount, errKey) {
  amount = Math.max(0, Number(amount ?? 0));
  if (amount <= 0) return true;

  const current = Number(foundry.utils.getProperty(actor, path) ?? 0);
  if (current < amount) {
    await postMisuse(actor, errKey, { need: amount, have: current });
    return false;
  }
  await actor.update({ [path]: current - amount });
  return true;
}

async function rollSuccessPool({ actor, label, dice, rerolls = 0, flavor = "" }) {
  dice = Math.max(0, Number(dice ?? 0));
  rero
