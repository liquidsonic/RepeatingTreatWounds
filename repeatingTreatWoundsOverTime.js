// Ensure only one token is selected
if (canvas.tokens.controlled.length !== 1) {
  return ui.notifications.info("Please select a token");
}
let playerToken = canvas.tokens.controlled[0];

// Ensure at least one target is selected
const targets = game.user.targets;
if (targets.size <= 0) {
  return ui.notifications.info("Please target 1 token");
}

// Function to check if the player has a specific feat by its slug
const checkIfFeat = (slugName) =>
  playerToken.actor.itemTypes.feat.some((f) => f.slug === slugName);

// Function to handle natural 1 and 20 results for crit fail/crit success
const handleCrits = (roll) => (roll === 1 ? -10 : roll === 20 ? 10 : 0);

// Clamp function to keep a number between min and max
const clamp = (num, a, b) =>
  Math.max(Math.min(num, Math.max(a, b)), Math.min(a, b));

// Arrays and variables to track healing progress
let missingHpArray = [],
  currentHpArray = [],
  maxHpArray = [],
  targetArray = [];

let totalHealed = 0,
  wardMedic = 1,
  bonusHealing = 0;
let hourCount = 0,
  dc = 15;

let chat = "";
let fullyHealedTokens = new Set();
let healingQueue = [];
let remainingQueue = [];
let riskySurgery;

const medicine = token.actor.skills.medicine.rank;

// Async roll function used for each target
async function rollForTarget(i) {
  let rolls = await new Roll("1d20").evaluate({ async: true });
  return { rolls };
}

// Iterate through all targets and gather HP values
for (let token of targets) {
  let maxHP = token.actor.system.attributes.hp.max;
  let currentHP = token.actor.system.attributes.hp.value;

  if (maxHP !== currentHP) {
    targetArray.push(token);
    missingHpArray.push(maxHP - currentHP);
    currentHpArray.push(currentHP);
    maxHpArray.push(maxHP);
  } else {
    ui.notifications.info(token.name + " Is already fully healed!");
  }
}

// Calculate total HP needed to heal
let totalHP = missingHpArray.reduce((a, b) => a + b, 0);

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Function to build the dialog content for user input
const renderDialogContent = () => `
<form>
    <p>
        This macro automates the Treat Wounds action over time, allowing you to heal multiple targets while taking into account Medicine DC, additional healing effects, and special feats like Ward Medic, Continual Recovery, and Risky Surgery.
    </p>
    <p>The macro will output the results every hour.</p>
    <p><strong>Yellow Tint</strong> means bonus healing applied.</p>
    <p><strong>Green Tint</strong> means the process finished on that hour.</p>
    
    ${
      checkIfFeat("ward-medic")
        ? `<p><strong>Ward Medic is active</strong></p>`
        : ""
    }
    ${
      checkIfFeat("continual-recovery")
        ? `<p><strong>Continual Recovery is active</strong></p>`
        : ""
    }

  <div class="form-group">
        <label>Double healing for an hour?</label>
        <input type="checkbox" id="healForHour" name="healForHour" value="false"/>
    </div>

    <div class="form-group">
        <label>Medicine DC:</label>
        <select id="dc-type" name="dc-type">
            <option value="15" selected>DC 15 (Trained)</option>
            <option value="20">DC 20 (Expert) (+10 hp)</option>
            <option value="30">DC 30 (Master) (+30 hp)</option>
            <option value="40">DC 40 (Legendary) (+50 hp)</option>
        </select>
    </div>

    <div class="form-group">
        <label>Roll Modifier:</label>
        <input id="modifier" name="modifier" type="number" value="0"/>
    </div>

    <div class="form-group">
        <label>Additional Healing:</label>
        <input id="additionalHealing" name="additionalHealing" type="string" value="1d0"/>
    </div>

        ${
      !checkIfFeat("continual-recovery")
        ? `
  <div class="form-group">
        <label>Used every 10 minutes?</label>
        <input type="checkbox" id="hourCountorMinuteCount" name="hourCountorMinuteCount" value="false"/>
    </div>`
        : ""
    }

        <div class="form-group">
        <label>Bonus healing Applies to all Targets?</label>
        <input type="checkbox" id="bonusTargets" name="bonusTargets" value="false"/>
    </div>

            <div class="form-group">
        <label>Bonus healing Applies to first Target?</label>
        <input type="checkbox" id="firstTargets" name="firstTargets" value="false"/>
    </div>

    ${
      checkIfFeat("risky-surgery")
        ? `
    <div class="form-group">
        <input type="checkbox" id="risky_surgery" name="risky_surgery" value="true"/>
    </div>`
        : ""
    }
</form>`;

// Function that runs when dialog is submitted
const applyChanges = async ($html) => {
  dc = parseInt($html.find('[name="dc-type"]')[0].value);
  var isRiskySurgery = $html.find('[name="risky_surgery"]')[0]?.checked;
  var hourCountorMinuteCount = $html.find('[name="hourCountorMinuteCount"]')[0]
    ?.checked;
  var modifier = parseInt($html.find('[name="modifier"]').val()) || 0;
  var bonusTargets = $html.find('[name="bonusTargets"]')[0]?.checked;
  var firstTargets = $html.find('[name="firstTargets"]')[0]?.checked;
  var healForHour = $html.find('[name="healForHour"]')[0]?.checked;
  var additionalHealing = $html.find('[name="additionalHealing"]').val() || 0;
  bonusHealing = { 20: 10, 30: 30, 40: 50 }[dc] || 0;

  // Begin chat message
  chat = `<h2>Treat Wounds Over Time</h2><b>DC ${dc} / ${totalHP} HP to Heal</b><hr>`;

  // Add feat messages to chat log
  if (checkIfFeat("continual-recovery")) {
    chat += `<p><b>Continual Recovery:</b> You zealously monitor a patient's progress to administer treatment faster.</p>`;
  }
  if (checkIfFeat("ward-medic")) {
    chat += `<p><b>Ward Medic:</b> You have trained in treating multiple patients at once.</p>`;
  }
  if (isRiskySurgery) {
    chat += `<p><b>Risky Surgery:</b> Your surgery can bring a patient back from the brink of death, but might push them over the edge.</p>`;
    modifier += 2;
  }

  if (additionalHealing !="1d0") {
    chat += `<p><b>Receiving Bonus Healing:</b> An additional source is adding ${additionalHealing} HP per ${
      hourCountorMinuteCount || checkIfFeat("continual-recovery")
        ? ` 10 minutes`
        : `per hour`
    } </p>`;
  }

  // Main treatment loop, capped at 30 cycles (30 hours max)
  let whileLoopCount = 0,
    maxIterations = 30;
  chat += `<table style="font-size: 14px; border-collapse: collapse; width: 100%; table-layout: fixed;"><tr><th style="padding: 0 2px;">Target</th><th style="padding: 0 2px;">Roll<br>(+${
    playerToken.actor.system.skills.medicine.totalModifier + modifier
  })</th><th style="padding: 0 2px;">Result</th><th style="padding: 0 2px;">HP +/- <br>(+Bon)</th><th style="padding: 0 2px;">Current HP</th></tr>`;

  // Determine Ward Medic capacity based on medicine skill
  wardMedic = playerToken.actor.itemTypes.feat.some(
    (f) => f.slug === "ward-medic"
  )
    ? 2
    : 1;
  if (medicine == 3) wardMedic = 4;
  if (medicine == 4) wardMedic = 8;

  // Split targets into healing queue and remaining queue
  healingQueue = targetArray.slice(0, wardMedic);
  remainingQueue = targetArray.slice(wardMedic);

  // Process healing rounds
  while (
    (healingQueue.length > 0 || remainingQueue.length > 0) &&
    whileLoopCount < maxIterations
  ) {
    whileLoopCount++;
    let newQueue = [];
    let firstIndex = healingQueue[0];

    // Process each target in the current healing queue
    for (let i = 0; i < healingQueue.length; i++) {
      let targetIndex = targetArray.indexOf(healingQueue[i]);
      let { rolls } = await rollForTarget(i);
      let roll = rolls.total;
      let crit = handleCrits(roll);

      let totalRoll =
        roll +
        playerToken.actor.system.skills.medicine.totalModifier +
        modifier;
      let result,
        hpChange = 0;
        let dblhealForHour = 1; // Default healing multiplier
      // If healForHour is checked, double the healing for the hour
      if (healForHour) {
        dblhealForHour = 2; // Double healing bonus for the hour
      }
      let externalHeals = 0;

      // Standard treatment or Risky Surgery logic
      if (!isRiskySurgery) {
        if (totalRoll + crit >= dc + 10) {
          hpChange =
            (await new Roll("4d8").evaluate({ async: true })).total*dblhealForHour +
            bonusHealing;
          result = "CrS";
        } else if (totalRoll + crit >= dc) {
          hpChange =
            (await new Roll("2d8").evaluate({ async: true })).total*dblhealForHour +
            bonusHealing;
          result = "Suc";
        } else if (totalRoll + crit <= dc - 10) {
          hpChange -=
            (await new Roll("1d8").evaluate({ async: true })).total +
            bonusHealing;
          result = "CrFail";
        } else {
          result = "Fail";
        }
      } else {
        riskySurgery = (await new Roll("1d8").evaluate({ async: true })).total;
        if (totalRoll + crit >= dc) {
          hpChange =
            (await new Roll("4d8").evaluate({ async: true })).total +
            bonusHealing -
            riskySurgery;
          result = "CrS";
        } else {
          hpChange -=
            (await new Roll("1d8").evaluate({ async: true })).total -
            riskySurgery;
          result = "Fail";
        }
      }





      // If bonus targets is checked in the UI prompt, heal all targets
      if (bonusTargets) {
        externalHeals = (
          await new Roll(additionalHealing).evaluate({ async: true })
        ).total;
        hpChange += externalHeals;
      }

      // If this bonus healing only applies to the first target in the row
      if (firstTargets && healingQueue[i] == firstIndex) {
        for (let i = 0; i < 5; i++) {
          externalHeals = (
            await new Roll(additionalHealing).evaluate({ async: true })
          ).total;
        }
        hpChange += externalHeals;
      }

            // If continual recovery is inactive and 10 minute per ability is. Roll the dice an additional five times and add

      if (!checkIfFeat("continual-recovery") && hourCountorMinuteCount)

        {
          externalHeals += (
            await new Roll(additionalHealing).evaluate({ async: true })
          ).total;
          externalHeals += (
            await new Roll(additionalHealing).evaluate({ async: true })
          ).total;
          externalHeals += (
            await new Roll(additionalHealing).evaluate({ async: true })
          ).total;
          externalHeals += (
            await new Roll(additionalHealing).evaluate({ async: true })
          ).total;
          externalHeals += (
            await new Roll(additionalHealing).evaluate({ async: true })
          ).total;
        }

      // Clamp HP to max and update healing status
      currentHpArray[targetIndex] = clamp(
        currentHpArray[targetIndex] + hpChange,
        0,
        maxHpArray[targetIndex]
      );
      let hpDisplay = `${currentHpArray[targetIndex]}/<br>${maxHpArray[targetIndex]}`;

      if (currentHpArray[targetIndex] >= maxHpArray[targetIndex]) {
        fullyHealedTokens.add(healingQueue[i].name);
      } else {
        newQueue.push(healingQueue[i]);
      }

      // Format row style in chat log
      let rowStyle =
        currentHpArray[targetIndex] >= maxHpArray[targetIndex]
          ? "style='background-color: lightgreen;'"
          : i == 0 && externalHeals
          ? "style='background-color: lightyellow;'"
          : "";

      chat += `<tr ${rowStyle}><td style="padding: 0 2px; white-space: nowrap;">${healingQueue[i].name.substring(
        0,
        6
      )}...</td><td style="padding: 0 8px;">${
        roll + playerToken.actor.system.skills.medicine.totalModifier + modifier
      }</td><td style="padding: 0 8px;">${result}</td><td style="white-space: nowrap; text-align: center;">${hpChange - externalHeals}${
        (externalHeals != 0 && i == 0 && firstTargets) || bonusTargets || hourCountorMinuteCount
          ? `<br>(+${externalHeals})`
          : ``
      } </td><td style="padding: 0 8px;">${hpDisplay}</td></tr>`;
    }

    // Prepare next queue based on remaining targets
    healingQueue = newQueue.concat(
      remainingQueue.slice(0, wardMedic - newQueue.length)
    );
    remainingQueue = remainingQueue.slice(wardMedic - newQueue.length);

    // Track time spent
    hourCount += checkIfFeat("continual-recovery") || !healForHour ? 0.167 : 1;
    chat += `<tr style="background-color: black; color: white;"><td colspan="5">${Math.floor(
      hourCount
    )} hours, ${Math.round((hourCount % 1) * 60)} minutes elapsed</td></tr>`;

    // Exit if all targets are healed
    if (healingQueue.length === 0 && remainingQueue.length === 0) {
      break;
    }
  }

  // Close table and post chat message
  chat += `</table>`;
  ChatMessage.create({
    user: game.user.id,
    content: chat,
    speaker: ChatMessage.getSpeaker(),
  });
};

// Open the dialog to collect user input
new Dialog({
  title: "Treat Wounds Options Over Time",
  content: renderDialogContent(),
  buttons: {
    ok: { label: "Apply", callback: applyChanges },
    cancel: { label: "Cancel" },
  },
  default: "ok",
}).render(true);
