/* global ActorSheet, ItemSheet, game, ui, Hooks, ChatMessage, Roll, foundry, Dialog */

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

function isMyTurn(actor) {
  const combat = game.combat;
  if (!combat) return true;
  const current = combat.combatant?.actor;
  return current?.id === actor.id;
}

function getEquippedWeapons(actor) {
  return actor.items.filter(i => i.type === "weapon" && (i.system?.equipped === true || i.system?.equipped?.value === true));
}

function getEquippedArmor(actor) {
  const armors = actor.items.filter(i => i.type === "armor" && (i.system?.equipped === true || i.system?.equipped?.value === true));
  return armors[0] ?? null;
}

function armorIsBroken(armor) {
  if (!armor) return false;
  return Boolean(armor.system?.broken?.value ?? armor.system?.broken ?? false) || Number(armor.system?.durability?.value ?? 0) <= 0;
}

function getMaxWeaponInitiativeBonus(actor) {
  const weapons = getEquippedWeapons(actor);
  return weapons.reduce((m, w) => Math.max(m, Number(w.system?.initiativeBonus?.value ?? w.system?.initiativeBonus ?? 0)), 0);
}

function getTargetActorFromUser() {
  const targets = Array.from(game.user.targets ?? []);
  if (targets.length !== 1) return { actor: null, token: null, reason: "HKRPG.Errors.NeedOneTarget" };
  const token = targets[0];
  const actor = token?.actor ?? null;
  if (!actor) return { actor: null, token: null, reason: "HKRPG.Errors.InvalidTarget" };
  return { actor, token, reason: null };
}

async function spendResource(actor, path, amount, errKey, dataForErr) {
  amount = Math.max(0, Number(amount ?? 0));
  if (amount <= 0) return true;

  const current = Number(foundry.utils.getProperty(actor, path) ?? 0);
  if (current < amount) {
    await postMisuse(actor, errKey, dataForErr ?? { need: amount, have: current });
    return false;
  }
  await actor.update({ [path]: current - amount });
  return true;
}

function hasAnySix(roll) {
  try {
    const results = roll?.dice?.[0]?.results ?? [];
    return results.some(r => Number(r.result) === 6);
  } catch {
    return false;
  }
}

function getAbsorptionValue(actor) {
  const v1 = Number(foundry.utils.getProperty(actor, "system.combat.absorption.value") ?? NaN);
  if (!Number.isNaN(v1)) return v1;

  const v2 = Number(foundry.utils.getProperty(actor, "system.absorption.value") ?? NaN);
  if (!Number.isNaN(v2)) return v2;

  const v3 = Number(foundry.utils.getProperty(actor, "system.pools.absorption.value") ?? NaN);
  if (!Number.isNaN(v3)) return v3;

  return 0;
}

/**
 * Поглощение по книге:
 * снижает оставшийся урон на (1 + floor(remaining / absorptionValue))
 * применяется после ПУ и Впитывания.
 */
function applyAbsorption(remainingDamage, absorptionValue) {
  remainingDamage = Math.max(0, Number(remainingDamage ?? 0));
  absorptionValue = Math.max(0, Number(absorptionValue ?? 0));

  if (remainingDamage <= 0 || absorptionValue <= 0) {
    return { finalDamage: remainingDamage, reducedBy: 0 };
  }

  const reducedBy = 1 + Math.floor(remainingDamage / absorptionValue);
  const finalDamage = Math.max(0, remainingDamage - reducedBy);
  return { finalDamage, reducedBy };
}

async function rollSuccessPool({ actor, label, dice, rerolls = 0, flavor = "", flags = {} }) {
  dice = Math.max(0, Number(dice ?? 0));
  rerolls = Math.max(0, Number(rerolls ?? 0));

  if (dice <= 0) {
    await postMisuse(actor, "HKRPG.Errors.NoDice");
    return null;
  }

  const roll = await new Roll(`${dice}d6cs>=5`).evaluate({ async: true });

  // Перебросы: перебрасываем провалы
  let remaining = rerolls;
  if (remaining > 0) {
    const results = roll.dice[0]?.results ?? [];
    const failuresIdx = results
      .map((r, idx) => ({ r, idx }))
      .filter(x => !x.r.success);

    for (let i = 0; i < Math.min(remaining, failuresIdx.length); i++) {
      const idx = failuresIdx[i].idx;
      const newRoll = await new Roll(`1d6cs>=5`).evaluate({ async: true });
      results[idx] = newRoll.dice[0].results[0];
    }
    roll._total = results.filter(r => r.success).length;
  }

  const html = await renderTemplate("systems/hollow-knight/chat/roll-card.html", {
    title: label,
    dice,
    successes: roll.total,
    rerolls,
    flavor
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: html,
    roll,
    type: CONST.CHAT_MESSAGE_TYPES.ROLL,
    flags
  });

  return roll;
}

async function rollInitiative(actor) {
  const grace = Number(actor.system?.characteristics?.grace?.value ?? 0);
  const bonus = getMaxWeaponInitiativeBonus(actor) + Number(actor.system?.combat?.initiativeBonus?.value ?? 0);

  const dice = Math.max(0, Math.floor(grace + bonus));
  if (dice <= 0) {
    await postMisuse(actor, "HKRPG.Errors.NoDice");
    return null;
  }

  const roll = await new Roll(`${dice}d6`).evaluate({ async: true });
  const html = await renderTemplate("systems/hollow-knight/chat/roll-card.html", {
    title: t("HKRPG.Chat.Initiative"),
    dice,
    successes: roll.total,
    rerolls: 0,
    flavor: t("HKRPG.Chat.InitiativeFlavor", { grace, bonus })
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: html,
    roll,
    type: CONST.CHAT_MESSAGE_TYPES.ROLL
  });

  await actor.update({ "system.combat.initiative.value": roll.total });
  return roll;
}

async function askAttackDialog(actor) {
  const weapons = getEquippedWeapons(actor);
  if (!weapons.length) {
    await postMisuse(actor, "HKRPG.Errors.NoEquippedWeapons");
    return null;
  }

  const options = weapons
    .map(w => `<option value="${w.id}">${foundry.utils.escapeHTML(w.name)}</option>`)
    .join("");

  return new Promise(resolve => {
    new Dialog({
      title: t("HKRPG.Dialog.AttackTitle"),
      content: `
        <div class="form-group">
          <label>${t("HKRPG.Dialog.Weapon")}</label>
          <select name="weapon">${options}</select>
        </div>
        <div class="form-group">
          <label>${t("HKRPG.Dialog.StaminaInvest")}</label>
          <input type="number" name="invest" value="1" min="1" step="1"/>
        </div>
      `,
      buttons: {
        ok: {
          icon: '<i class="fas fa-dice"></i>',
          label: t("HKRPG.UI.Roll"),
          callback: html => {
            const weaponId = String(html.find('select[name="weapon"]').val());
            const invest = Number(html.find('input[name="invest"]').val() ?? 1);
            resolve({ weaponId, invest });
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: t("HKRPG.UI.Cancel"),
          callback: () => resolve(null)
        }
      },
      default: "ok"
    }).render(true);
  });
}

function getWeaponRangeCategory(weapon) {
  return (weapon.system?.range?.category?.value ?? weapon.system?.range?.value ?? weapon.system?.range ?? "melee");
}

function getWeaponRangeDistance(weapon) {
  return Number(weapon.system?.range?.distance?.value ?? weapon.system?.range?.distance ?? 1);
}

async function createAttackCard({ attacker, target, weapon, investStamina, staminaTax, totalCost, roll }) {
  const attackSuccesses = Number(roll?.total ?? 0);
  const attackHasSix = hasAnySix(roll);
  const range = getWeaponRangeCategory(weapon);
  const rangeDistance = getWeaponRangeDistance(weapon);

  const flags = {
    [SYS_ID]: {
      kind: "attack",
      attackerActorId: attacker.id,
      attackerName: attacker.name,

      targetActorId: target.id,
      targetName: target.name,

      weaponItemId: weapon.id,
      weaponName: weapon.name,
      weaponType: weapon.system?.type?.value ?? weapon.system?.type ?? "",
      baseDamage: Number(weapon.system?.damage?.value ?? weapon.system?.damage ?? 0),
      quality: Number(weapon.system?.quality?.value ?? weapon.system?.quality ?? 0),

      range,
      rangeDistance,

      investStamina,
      staminaTax,
      totalCost,

      attackSuccesses,
      attackHasSix,

      defense: null,
      soak: null
    }
  };

  const msg = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker }),
    content: `<div class="hkrpg-attack-card">...</div>`,
    flags
  });

  const html = await renderTemplate("systems/hollow-knight/chat/attack-card.html", {
    messageId: msg.id,
    attackerName: attacker.name,
    targetName: target.name,
    weaponName: weapon.name,
    attackSuccesses,
    baseDamage: Number(weapon.system?.damage?.value ?? 0),
    range,
    rangeDistance,
    investStamina,
    staminaTax,
    totalCost
  });

  await msg.update({ content: html });
  return msg;
}

async function attackWithWeapon(attacker, weapon, investStamina) {
  if (game.combat && !isMyTurn(attacker)) {
    await postMisuse(attacker, "HKRPG.Errors.NotYourTurn");
    return null;
  }

  const tgt = getTargetActorFromUser();
  if (!tgt.actor) {
    await postMisuse(attacker, tgt.reason);
    return null;
  }
  const target = tgt.actor;

  investStamina = Math.max(1, Math.floor(Number(investStamina ?? 1)));

  const attacksThisTurn = Number(attacker.system?.turn?.attacksThisTurn ?? 0);
  const staminaTax = Math.max(0, attacksThisTurn);
  const totalCost = investStamina + staminaTax;

  const ok = await spendResource(
    attacker,
    "system.pools.stamina.value",
    totalCost,
    "HKRPG.Errors.NotEnoughStaminaForAttack",
    { need: totalCost, have: Number(attacker.system?.pools?.stamina?.value ?? 0) }
  );
  if (!ok) return null;

  const quality = Number(weapon.system?.quality?.value ?? weapon.system?.quality ?? 0);
  const isRanged = getWeaponRangeCategory(weapon) === "ranged";

  const base = isRanged
    ? Number(attacker.system?.characteristics?.grace?.value ?? 0)
    : Number(attacker.system?.characteristics?.might?.value ?? 0);

  const dice = Math.max(0, Math.floor(base + quality + investStamina));
  const rerolls = Number(weapon.system?.rerolls?.value ?? weapon.system?.rerolls ?? 0);

  await attacker.update({ "system.turn.attacksThisTurn": attacksThisTurn + 1 });

  const roll = await new Roll(`${dice}d6cs>=5`).evaluate({ async: true });

  // перебросы
  let remaining = rerolls;
  if (remaining > 0) {
    const results = roll.dice[0]?.results ?? [];
    const failuresIdx = results
      .map((r, idx) => ({ r, idx }))
      .filter(x => !x.r.success);

    for (let i = 0; i < Math.min(remaining, failuresIdx.length); i++) {
      const idx = failuresIdx[i].idx;
      const newRoll = await new Roll(`1d6cs>=5`).evaluate({ async: true });
      results[idx] = newRoll.dice[0].results[0];
    }
    roll._total = results.filter(r => r.success).length;
  }

  await createAttackCard({
    attacker,
    target,
    weapon,
    investStamina,
    staminaTax,
    totalCost,
    roll
  });

  return roll;
}

async function rollDefense(defender, type) {
  if (game.combat && !isMyTurn(defender)) {
    await postMisuse(defender, "HKRPG.Errors.NotYourTurn");
    return null;
  }

  const value =
    type === "dodge"
      ? Number(defender.system?.characteristics?.grace?.value ?? 0)
      : Number(defender.system?.characteristics?.might?.value ?? 0);

  const label = type === "dodge" ? t("HKRPG.Chat.Dodge") : t("HKRPG.Chat.Parry");
  const roll = await rollSuccessPool({ actor: defender, label, dice: Math.floor(value) });
  return roll;
}

async function rollSoak(defender) {
  const armor = getEquippedArmor(defender);
  const broken = armorIsBroken(armor);

  if (!armor || broken) {
    return { armor: armor ?? null, soakSuccesses: 0, pu: 0, roll: null };
  }

  // Впитывание урона: проверка Панциря (плюс бонусы брони), каждый успех -1 урона :contentReference[oaicite:1]{index=1}
  const shell = Number(defender.system?.characteristics?.shell?.value ?? 0);
  const soakBonus = Number(armor.system?.soakBonus?.value ?? armor.system?.absorptionBonus?.value ?? 0);
  const rerolls = Number(armor.system?.soakRerolls?.value ?? armor.system?.absorptionRerolls?.value ?? 0);
  const pu = Number(armor.system?.pu?.value ?? 0);

  const dice = Math.max(0, Math.floor(shell + soakBonus));
  const roll = await rollSuccessPool({
    actor: defender,
    label: t("HKRPG.Chat.Soak"),
    dice,
    rerolls,
    flavor: `${t("HKRPG.Chat.SoakArmor")}: ${armor.name}\n${t("HKRPG.Chat.PU")}: ${pu}`
  });

  return { armor, soakSuccesses: Number(roll?.total ?? 0), pu, roll };
}

async function applyArmorBreakIfNeeded(attackFlags) {
  if (!attackFlags?.attackHasSix) return;
  if (Number(attackFlags?.attackSuccesses ?? 0) <= 0) return;

  const target = game.actors.get(attackFlags.targetActorId);
  if (!target) return;

  const armor = getEquippedArmor(target);
  if (!armor) return;

  const cur = Number(armor.system?.durability?.value ?? 0);
  const max = Number(armor.system?.durability?.max ?? cur);
  const next = Math.max(0, cur - 1);
  const broken = next <= 0;

  await armor.update({
    "system.durability.value": next,
    "system.durability.max": Math.max(max, 0),
    "system.broken.value": broken
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: target }),
    content: `<div class="hkrpg-warn"><b>${t("HKRPG.Chat.ArmorDamage")}</b>: ${armor.name} (-1 прочность, теперь ${next}/${max})${broken ? ` — <b>${t("HKRPG.Chat.ArmorBroken")}</b>` : ""}</div>`
  });
}

async function applyDamageFromAttack(attackMsg) {
  const f = attackMsg.flags?.[SYS_ID];
  if (!f || f.kind !== "attack") return;

  const attacker = game.actors.get(f.attackerActorId);
  const defender = game.actors.get(f.targetActorId);

  if (!attacker || !defender) {
    if (attacker) await postMisuse(attacker, "HKRPG.Errors.InvalidTarget");
    return;
  }

  const defenseSuccesses = Number(f.defense?.successes ?? 0);
  const soakSuccesses = Number(f.soak?.successes ?? 0);
  const pu = Number(f.soak?.pu ?? 0);

  const attackSuccesses = Number(f.attackSuccesses ?? 0);
  const netHits = Math.max(0, attackSuccesses - defenseSuccesses);

  const baseDamage = Number(f.baseDamage ?? 0);

  // Вероятный урон: базовый + доп. (мы берём доп. как netHits, затем ограничим)
  // Ограничение по книге: максимум доп. урона = max(базовый урон, вложенная выносливость). :contentReference[oaicite:2]{index=2}
  const invest = Number(f.investStamina ?? 0);
  const maxExtra = Math.max(baseDamage, invest);
  const extraDamage = Math.min(netHits, maxExtra);
  let probableDamage = Math.max(0, baseDamage + extraDamage);

  // ПУ: вычитается до Впитывания, но не может опустить нанесённый урон ниже 1. :contentReference[oaicite:3]{index=3}
  if (probableDamage > 0 && pu > 0) {
    probableDamage = Math.max(1, probableDamage - pu);
  }

  // Впитывание: каждый успех -1 урона :contentReference[oaicite:4]{index=4}
  let afterSoak = Math.max(0, probableDamage - soakSuccesses);

  // Поглощение по книге :contentReference[oaicite:5]{index=5}
  const absorptionValue = getAbsorptionValue(defender);
  const absRes = applyAbsorption(afterSoak, absorptionValue);
  const finalDamage = absRes.finalDamage;
  const absorbedBy = absRes.reducedBy;

  // списываем сердца
  if (finalDamage > 0) {
    const curHearts = Number(defender.system?.pools?.hearts?.value ?? 0);
    const nextHearts = Math.max(0, curHearts - finalDamage);
    await defender.update({ "system.pools.hearts.value": nextHearts });
  }

  await applyArmorBreakIfNeeded(f);

  const report = awa
