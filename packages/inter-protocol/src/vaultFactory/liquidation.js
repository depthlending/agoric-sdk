// @jessie-check

import { AmountMath } from '@agoric/ertp';
import { makeTracer } from '@agoric/internal';
import { observeIteration, subscribeEach } from '@agoric/notifier';
import { makeScalarMapStore } from '@agoric/store';
import { TimeMath } from '@agoric/time';
import { atomicRearrange } from '@agoric/zoe/src/contractSupport/index.js';
import { E } from '@endo/eventual-send';

import { AUCTION_START_DELAY, PRICE_LOCK_PERIOD } from '../auction/params.js';
import { makeCancelTokenMaker } from '../auction/util.js';

const trace = makeTracer('LIQ', false);

/** @typedef {import('@agoric/time/src/types').TimerService} TimerService */
/** @typedef {import('@agoric/time/src/types').TimerWaker} TimerWaker */
/** @typedef {import('@agoric/time/src/types').CancelToken} CancelToken */
/** @typedef {import('@agoric/time/src/types').RelativeTimeRecord} RelativeTimeRecord */

const makeCancelToken = makeCancelTokenMaker('liq');

/**
 * This will normally be set. If the schedule goes sideways, we'll unschedule
 * all events and unset it. When auction params are changed, we'll restart the schedule
 *
 * @type {object | undefined}
 */
let cancelToken = makeCancelToken();

const waitForRepair = () => {
  // the params observer will setWakeup to resume.
  console.warn(
    '🛠️ No wake for reschedule. Repair by resetting auction params.',
  );
};

// Generally, canceling wakups has to be followed by setting up new ones but
// not in the case of pausing wakeups. We do that in the event of invalid
// schedule params. When they are repaired by governance, the wakers resume.
/** @param {ERef<TimerService>} timer */
const cancelWakeups = timer => {
  if (cancelToken) {
    void E(timer).cancel(cancelToken);
  }
  cancelToken = undefined;
};

/**
 * Schedule wakeups for the *next* auction round.
 *
 * In practice, there are these cases to handle (with N as "live" and N+1 is "next"):
 *
 * | when (now within the range)      | what                                    |
 * | -------------------------------- | --------------------------------------- |
 * | [start N, nominalStart N+1]      | good: schedule normally the three wakers|
 * | (nominalStart N+1, endTime N+1]  | recover: skip round N+1 and schedule N+2|
 * | (endTime N+1, ∞)                 | give up: wait for repair by governance  |
 *
 * @param {object} opts
 * @param {ERef<TimerService>} opts.timer
 * @param {TimerWaker} opts.priceLockWaker
 * @param {TimerWaker} opts.liquidationWaker
 * @param {TimerWaker} opts.reschedulerWaker
 * @param {import('../auction/scheduler.js').Schedule} opts.nextAuctionSchedule
 * @param {import('@agoric/time/src/types').TimestampRecord} opts.now
 * @param {ParamStateRecord} opts.params
 * @returns {void}
 */
const setWakeups = ({
  nextAuctionSchedule,
  now,
  timer,
  reschedulerWaker,
  liquidationWaker,
  priceLockWaker,
  params,
}) => {
  const { startTime, endTime } = nextAuctionSchedule;

  /** @type {RelativeTimeRecord} */
  // @ts-expect-error Casting
  // eslint-disable-next-line no-restricted-syntax -- https://github.com/Agoric/eslint-config-jessie/issues/33
  const priceLockPeriod = params[PRICE_LOCK_PERIOD].value;
  /** @type {RelativeTimeRecord} */
  // @ts-expect-error Casting
  // eslint-disable-next-line no-restricted-syntax -- https://github.com/Agoric/eslint-config-jessie/issues/33
  const auctionStartDelay = params[AUCTION_START_DELAY].value;

  // nominal is the declared start time, but the actual auctioning begins after auctionStartDelay
  const nominalStart = TimeMath.subtractAbsRel(startTime, auctionStartDelay);
  const afterStart = TimeMath.addAbsRel(startTime, 1n);

  // Is there a problem (case 2 or 3)?
  // setWakeupsForNextAuction is supposed to be called just after an auction
  // started. If we're late but there's still time for the nominal start, then
  // we'll proceed. Reschedule for the next round if that's still in the future.
  // Otherwise, wait for governance params to change.
  if (TimeMath.compareAbs(now, nominalStart) > 0) {
    // nominalStart is past
    cancelWakeups(timer);

    if (TimeMath.compareAbs(now, endTime) < 0) {
      trace('CASE 2: endTime is in the future or now so reschedule waking');
      void E(timer).setWakeup(afterStart, reschedulerWaker);
    } else {
      trace('CASE 3: endTime is past; wait for repair');
      waitForRepair();
    }

    return;
  }
  trace('CASE 1: nominalStart is now or in the future');

  cancelToken = cancelToken || makeCancelToken();
  const priceLockWakeTime = TimeMath.subtractAbsRel(
    nominalStart,
    priceLockPeriod,
  );
  const a = t => TimeMath.absValue(t);
  trace('scheduling ', a(priceLockWakeTime), a(nominalStart), a(startTime));
  void E(timer).setWakeup(priceLockWakeTime, priceLockWaker, cancelToken);
  void E(timer).setWakeup(nominalStart, liquidationWaker, cancelToken);
  // Call setWakeupsForNextAuction again one tick after nominalStart
  void E(timer).setWakeup(afterStart, reschedulerWaker, cancelToken);
};

/**
 * Schedule wakeups for the *next* auction round.
 *
 * Called by vaultDirector's resetWakeupsForNextAuction at start() and every
 * time there's a "reschedule" wakeup.
 *
 * @param {ERef<import('../auction/auctioneer.js').AuctioneerPublicFacet>} auctioneerPublicFacet
 * @param {ERef<TimerService>} timer
 * @param {TimerWaker} priceLockWaker
 * @param {TimerWaker} liquidationWaker
 * @param {TimerWaker} reschedulerWaker
 * @returns {Promise<void>}
 */
const setWakeupsForNextAuction = async (
  auctioneerPublicFacet,
  timer,
  priceLockWaker,
  liquidationWaker,
  reschedulerWaker,
) => {
  const [{ nextAuctionSchedule }, params, now] = await Promise.all([
    E(auctioneerPublicFacet).getSchedules(),
    E(auctioneerPublicFacet).getGovernedParams(),
    E(timer).getCurrentTimestamp(),
  ]);

  trace('SCHEDULE', now.absValue, nextAuctionSchedule);
  if (!nextAuctionSchedule) {
    // There should always be a nextAuctionSchedule. If there isn't, give up for now.
    cancelWakeups(timer);
    waitForRepair();
    return;
  }

  setWakeups({
    nextAuctionSchedule,
    now,
    timer,
    reschedulerWaker,
    liquidationWaker,
    priceLockWaker,
    params,
  });
};

/**
 * @param {Amount<'nat'>} debt
 * @param {Amount<'nat'>} minted
 * @returns {{ overage: Amount<'nat'>, shortfall: Amount<'nat'>, toBurn: Amount<'nat'>}}
 */
const liquidationResults = (debt, minted) => {
  if (AmountMath.isEmpty(minted)) {
    return {
      overage: minted,
      toBurn: minted,
      shortfall: debt,
    };
  }

  const [overage, shortfall] = AmountMath.isGTE(debt, minted)
    ? [AmountMath.makeEmptyFromAmount(debt), AmountMath.subtract(debt, minted)]
    : [AmountMath.subtract(minted, debt), AmountMath.makeEmptyFromAmount(debt)];

  const toBurn = AmountMath.min(minted, debt);
  // debt is fully accounted for, with toBurn and shortfall
  assert(AmountMath.isEqual(debt, AmountMath.add(toBurn, shortfall)));

  return {
    overage,
    toBurn,
    shortfall,
  };
};

/**
 * Watch governed params for change
 *
 * @param {ERef<import('../auction/auctioneer.js').AuctioneerPublicFacet>} auctioneerPublicFacet
 * @param {ERef<TimerService>} timer
 * @param {TimerWaker} reschedulerWaker
 * @returns {void}
 */
export const watchForGovernanceChange = (
  auctioneerPublicFacet,
  timer,
  reschedulerWaker,
) => {
  void E.when(E(timer).getCurrentTimestamp(), now =>
    // make one observer that will usually ignore the update.
    observeIteration(
      subscribeEach(E(auctioneerPublicFacet).getSubscription()),
      harden({
        async updateState(_newState) {
          if (!cancelToken) {
            cancelToken = makeCancelToken();
            void E(timer).setWakeup(
              // bump one tick to prevent an infinite loop
              TimeMath.addAbsRel(now, 1n),
              reschedulerWaker,
              cancelToken,
            );
          }
        },
      }),
    ),
  );
};

/**
 * @param {ZCF} zcf
 * @param {object} collateralizationDetails
 * @param {PriceQuote} collateralizationDetails.quote
 * @param {Ratio} collateralizationDetails.interest
 * @param {Ratio} collateralizationDetails.margin
 * @param {ReturnType<typeof import('./prioritizedVaults.js').makePrioritizedVaults>} prioritizedVaults
 * @param {SetStore<Vault>} liquidatingVaults
 * @param {Brand<'nat'>} debtBrand
 * @param {Brand<'nat'>} collateralBrand
 * @returns {{
 *    vaultData: MapStore<Vault, { collateralAmount: Amount<'nat'>, debtAmount:  Amount<'nat'>}>,
 *    totalDebt: Amount<'nat'>,
 *    totalCollateral: Amount<'nat'>,
 *    liqSeat: ZCFSeat}}
 */
const getLiquidatableVaults = (
  zcf,
  collateralizationDetails,
  prioritizedVaults,
  liquidatingVaults,
  debtBrand,
  collateralBrand,
) => {
  const vaultsToLiquidate = prioritizedVaults.removeVaultsBelow(
    collateralizationDetails,
  );
  /** @type {MapStore<Vault, { collateralAmount: Amount<'nat'>, debtAmount:  Amount<'nat'>}>} */
  const vaultData = makeScalarMapStore();

  const { zcfSeat: liqSeat } = zcf.makeEmptySeatKit();
  let totalDebt = AmountMath.makeEmpty(debtBrand);
  let totalCollateral = AmountMath.makeEmpty(collateralBrand);
  /** @type {import('@agoric/zoe/src/contractSupport/atomicTransfer.js').TransferPart[]} */
  const transfers = [];

  for (const vault of vaultsToLiquidate.values()) {
    vault.liquidating();
    liquidatingVaults.add(vault);

    const collateralAmount = vault.getCollateralAmount();
    totalCollateral = AmountMath.add(totalCollateral, collateralAmount);

    const debtAmount = vault.getCurrentDebt();
    totalDebt = AmountMath.add(totalDebt, debtAmount);
    transfers.push([
      vault.getVaultSeat(),
      liqSeat,
      { Collateral: collateralAmount },
    ]);
    vaultData.init(vault, { collateralAmount, debtAmount });
  }

  if (transfers.length > 0) {
    atomicRearrange(zcf, harden(transfers));
  }

  return { vaultData, totalDebt, totalCollateral, liqSeat };
};

harden(setWakeupsForNextAuction);
harden(liquidationResults);
harden(getLiquidatableVaults);

export { setWakeupsForNextAuction, liquidationResults, getLiquidatableVaults };
