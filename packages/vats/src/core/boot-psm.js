// @ts-check
import { Far } from '@endo/far';
import {
  installGovAndPSMContracts,
  makeAnchorAsset,
  startPSM,
  PSM_MANIFEST,
  PSM_GOV_MANIFEST,
  startPSMCharter,
} from '@agoric/inter-protocol/src/proposals/startPSM.js';
import * as startPSMmod from '@agoric/inter-protocol/src/proposals/startPSM.js';
import * as ERTPmod from '@agoric/ertp';
// TODO: factor startEconomicCommittee out of econ-behaviors.js
import { fit, M } from '@agoric/store';
import {
  ECON_COMMITTEE_MANIFEST,
  startEconomicCommittee,
} from '@agoric/inter-protocol/src/proposals/startEconCommittee.js';
import { makeAgoricNamesAccess, makePromiseSpace } from './utils.js';
import { Stable, Stake } from '../tokens.js';
import {
  addBankAssets,
  buildZoe,
  installBootContracts,
  makeAddressNameHubs,
  makeBoard,
  makeVatsFromBundles,
  mintInitialSupply,
} from './basic-behaviors.js';
import * as utils from './utils.js';
import {
  bridgeCoreEval,
  makeBridgeManager,
  makeChainStorage,
  publishAgoricNames,
  startTimerService,
} from './chain-behaviors.js';
import { CHAIN_BOOTSTRAP_MANIFEST } from './manifest.js';
import {
  startWalletFactory,
  WALLET_FACTORY_MANIFEST,
} from './startWalletFactory.js';

/** @typedef {import('@agoric/inter-protocol/src/proposals/econ-behaviors.js').EconomyBootstrapSpace} EconomyBootstrapSpace */

/**
 * We reserve these keys in name hubs.
 */
export const agoricNamesReserved = harden(
  /** @type {const} */ ({
    issuer: {
      [Stake.symbol]: Stake.proposedName,
      [Stable.symbol]: Stable.proposedName,
      AUSD: 'Agoric bridged USDC',
    },
    brand: {
      [Stake.symbol]: Stake.proposedName,
      [Stable.symbol]: Stable.proposedName,
      AUSD: 'Agoric bridged USDC',
    },
    installation: {
      centralSupply: 'central supply',
      mintHolder: 'mint holder',
      walletFactory: 'multitenant smart wallet',
      contractGovernor: 'contract governor',
      committee: 'committee electorate',
      binaryVoteCounter: 'binary vote counter',
      psm: 'Parity Stability Module',
    },
    instance: {
      economicCommittee: 'Economic Committee',
      'psm-IST-AUSD': 'Parity Stability Module: IST:AUSD',
    },
  }),
);

/**
 * @typedef {{
 *   denom: string,
 *   keyword?: string,
 *   proposedName?: string,
 *   decimalPlaces?: number
 * }} AnchorOptions
 */
const AnchorOptionsShape = M.split(
  { denom: M.string() },
  M.partial({
    keyword: M.string(),
    proposedName: M.string(),
    decimalPlaces: M.number(),
  }),
);

/**
 * Build root object of the PSM-only bootstrap vat.
 *
 * @param {{
 *   D: DProxy
 *   logger?: (msg: string) => void
 * }} vatPowers
 * @param {{
 *     economicCommitteeAddresses: string[],
 *     anchorAssets: AnchorOptions[],
 * }} vatParameters
 */
export const buildRootObject = (vatPowers, vatParameters) => {
  const log = vatPowers.logger || console.info;

  const { anchorAssets, economicCommitteeAddresses } = vatParameters;
  fit(harden(anchorAssets), M.arrayOf(AnchorOptionsShape));
  fit(harden(economicCommitteeAddresses), M.arrayOf(M.string()));

  const { produce, consume } = makePromiseSpace(log);
  const { agoricNames, agoricNamesAdmin, spaces } = makeAgoricNamesAccess(
    log,
    agoricNamesReserved,
  );
  produce.agoricNames.resolve(agoricNames);
  produce.agoricNamesAdmin.resolve(agoricNamesAdmin);

  const runBootstrapParts = async (vats, devices) => {
    /** TODO: BootstrapPowers type puzzle */
    /** @type { any } */
    const allPowers = harden({
      vatPowers,
      vatParameters,
      vats,
      devices,
      produce,
      consume,
      ...spaces,
      // ISSUE: needed? runBehaviors,
      // These module namespaces might be useful for core eval governance.
      modules: {
        utils: { ...utils },
        startPSM: { ...startPSMmod },
        ERTP: { ...ERTPmod },
      },
    });
    const manifest = {
      ...CHAIN_BOOTSTRAP_MANIFEST,
      ...WALLET_FACTORY_MANIFEST,
      ...PSM_GOV_MANIFEST,
      ...ECON_COMMITTEE_MANIFEST,
      ...PSM_MANIFEST,
    };
    /** @param {string} name */
    const powersFor = name => {
      const permit = manifest[name];
      assert(permit, `missing permit for ${name}`);
      return utils.extractPowers(permit, allPowers);
    };

    await Promise.all([
      makeVatsFromBundles(powersFor('makeVatsFromBundles')),
      buildZoe(powersFor('buildZoe')),
      makeBoard(powersFor('makeBoard')),
      makeBridgeManager(powersFor('makeBridgeManager')),
      makeChainStorage(powersFor('makeChainStorage')),
      makeAddressNameHubs(powersFor('makeAddressNameHubs')),
      publishAgoricNames(powersFor('publishAgoricNames'), {
        options: {
          agoricNamesOptions: { topLevel: Object.keys(agoricNamesReserved) },
        },
      }),
      startWalletFactory(powersFor('startWalletFactory')),
      mintInitialSupply(powersFor('mintInitialSupply')),
      addBankAssets(powersFor('addBankAssets')),
      startTimerService(powersFor('startTimerService')),
      // centralSupply, mintHolder, walletFactory
      installBootContracts(powersFor('installBootContracts')),
      installGovAndPSMContracts(powersFor('installGovAndPSMContracts')),
      startEconomicCommittee(powersFor('startEconomicCommittee'), {
        options: {
          econCommitteeOptions: {
            committeeSize: economicCommitteeAddresses.length,
          },
        },
      }),
      ...anchorAssets.map(anchorOptions =>
        makeAnchorAsset(powersFor('makeAnchorAsset'), {
          options: { anchorOptions },
        }),
      ),
      ...anchorAssets.map(anchorOptions =>
        startPSM(powersFor('startPSM'), {
          options: { anchorOptions },
        }),
      ),
      startPSMCharter(powersFor('startPSMCharter')),
      // Allow bootstrap powers to be granted by governance
      // to code to be evaluated after initial bootstrap.
      bridgeCoreEval(powersFor('bridgeCoreEval')),
    ]);
  };

  return Far('bootstrap', {
    bootstrap: (vats, devices) => {
      const { D } = vatPowers;
      D(devices.mailbox).registerInboundHandler(
        Far('dummyInboundHandler', { deliverInboundMessages: () => {} }),
      );

      runBootstrapParts(vats, devices).catch(e => {
        console.error('BOOTSTRAP FAILED:', e);
        throw e;
      });
    },
    /**
     * Allow kernel to provide things to CORE_EVAL.
     *
     * @param {string} name
     * @param {unknown} resolution
     */
    produceItem: (name, resolution) => {
      assert.typeof(name, 'string');
      produce[name].resolve(resolution);
    },
    // expose reset in case we need to do-over
    resetItem: name => {
      assert.typeof(name, 'string');
      produce[name].reset();
    },
    // expose consume mostly for testing
    consumeItem: name => {
      assert.typeof(name, 'string');
      return consume[name];
    },
    // ??? any more dangerous than produceItem/consumeItem?
    /** @type {() => PromiseSpace} */
    getPromiseSpace: () => ({ consume, produce }),
  });
};

harden({ buildRootObject });