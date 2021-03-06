import { computed, onMounted, ref } from '@vue/composition-api';
import { BigNumber, Contract, getAddress, Web3Provider } from 'src/utils/ethers';
import { DomainService, KeyPair, Umbra } from '@umbra/umbra-js';
import { MulticallResponse, Network, Provider, Signer, supportedChainIds, SupportedChainIds } from 'components/models';
import Multicall from 'src/contracts/Multicall.json';
import ERC20 from 'src/contracts/ERC20.json';
import { formatAddress, lookupEnsName, lookupCnsName } from 'src/utils/address';
import { ITXRelayer } from 'src/utils/relayer';
import useSettingsStore from 'src/store/settings';
import Onboard from 'bnc-onboard';

/**
 * State is handled in reusable components, where each component is its own self-contained
 * file consisting of one function defined used the composition API.
 *
 * Since we want the wallet state to be shared between all instances when this file is imported,
 * we defined state outside of the function definition.
 */

const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ETH_TOKEN_INFO = {
  address: ETH_ADDRESS,
  name: 'Ether',
  decimals: 18,
  symbol: 'ETH',
  logoURI: '/tokens/eth.svg',
};

// ============================================= State =============================================
// We do not publicly expose the state to provide control over when and how it's changed. It
// can only be changed through actions and mutations, and it can only be accessed with getters.
// As a result, only actions, mutations, and getters are returned from this function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawProvider = ref<any>(); // raw provider from the user's wallet, e.g. EIP-1193 provider
const provider = ref<Provider>(); // ethers provider
const signer = ref<Signer>(); // ethers signer
const userAddress = ref<string>(); // user's wallet address
const userEns = ref<string>(); // user's ENS name
const userCns = ref<string>(); // user's CNS name
const network = ref<Network>(); // connected network, derived from provider
const umbra = ref<Umbra>(); // instance of Umbra class
const domainService = ref<DomainService>(); // instance DomainService class
const spendingKeyPair = ref<KeyPair>(); // KeyPair instance, with private key, for spending receiving funds
const viewingKeyPair = ref<KeyPair>(); // KeyPair instance, with private key, for scanning for received funds
const balances = ref<Record<string, BigNumber>>({}); // mapping from token address to user's wallet balance
const relayer = ref<ITXRelayer>(); // used for managing relay transactions
const hasEnsKeys = ref(false); // true if user has set stealth keys on their ENS name
const hasCnsKeys = ref(false); // true if user has set stealth keys on their CNS name
const onboard = ref(); // blocknative's onboard.js instance

// ========================================== Main Store ===========================================
export default function useWalletStore() {
  onMounted(async () => {
    const { lastWallet } = useSettingsStore();

    // Initialize onboard.js if not yet done
    if (!onboard.value) {
      onboard.value = Onboard({
        dappId: process.env.BLOCKNATIVE_API_KEY,
        networkId: 1,
        walletCheck: [{ checkName: 'connect' }],
        subscriptions: {
          wallet: (wallet) => setProvider(wallet.provider),
          address: async (address) => {
            if (userAddress.value && userAddress.value !== getAddress(address)) {
              await configureProvider();
            }
          },
          network: async (chainId) => {
            if (network.value?.chainId && network.value.chainId !== chainId) {
              await configureProvider();
            }
          },
        },
      });
    }

    // Try to connect to the last used wallet
    if (lastWallet.value) {
      await onboard.value.walletSelect(lastWallet.value);
      await onboard.value.walletCheck();
      await configureProvider(); // get ENS name, CNS names, etc.
    }
  });

  // ------------------------------------------- Actions -------------------------------------------

  async function getTokenBalances() {
    // Setup
    if (!provider.value) throw new Error('Provider not connected');
    if (!relayer.value) throw new Error('Relayer instance not found');
    const network = await provider.value.getNetwork();
    const chainId = String(network.chainId) as SupportedChainIds;
    const multicallAddress = Multicall.addresses[chainId];
    const multicall = new Contract(multicallAddress, Multicall.abi, provider.value);

    // Generate balance calls using Multicall contract
    const calls = tokens.value.map((token) => {
      const { address: tokenAddress } = token;
      if (tokenAddress === ETH_ADDRESS) {
        return {
          target: multicallAddress,
          callData: multicall.interface.encodeFunctionData('getEthBalance', [userAddress.value]),
        };
      } else {
        const tokenContract = new Contract(tokenAddress, ERC20.abi, signer.value);
        return {
          target: tokenAddress,
          callData: tokenContract.interface.encodeFunctionData('balanceOf', [userAddress.value]),
        };
      }
    });

    // Send the call
    const response = await multicall.callStatic.aggregate(calls);
    const multicallResponse = (response as MulticallResponse).returnData;

    // Set balances mapping
    tokens.value.forEach((token, index) => {
      balances.value[token.address] = BigNumber.from(multicallResponse[index]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setProvider(p: any) {
    rawProvider.value = p;
  }

  async function configureProvider() {
    // Set network/wallet properties
    if (!rawProvider.value) return;
    provider.value = new Web3Provider(rawProvider.value);
    signer.value = provider.value.getSigner();

    // Get user and network information
    const [_userAddress, _network, _relayer] = await Promise.all([
      signer.value.getAddress(), // get user's address
      provider.value.getNetwork(), // get information on the connected network
      ITXRelayer.create(provider.value), // Configure the relayer (even if not withdrawing, this gets the list of tokens we allow to send)
    ]);

    // If nothing has changed, no need to continue configuring
    if (_userAddress === userAddress.value && _network.chainId === network.value?.chainId) {
      return;
    }

    // Clear state
    resetState();

    // Exit if not a valid network
    const chainId = provider.value.network.chainId; // must be done after the .getNetwork() calls
    if (!supportedChainIds.includes(_network.chainId)) {
      network.value = _network;
      return;
    }

    // Set Umbra and DomainService classes
    umbra.value = new Umbra(provider.value, chainId);
    domainService.value = new DomainService(provider.value);

    // Get ENS and CNS names
    const [_userEns, _userCns] = await Promise.all([
      lookupEnsName(_userAddress, provider.value),
      lookupCnsName(_userAddress, provider.value),
    ]);

    // Check if user has keys setup with their ENS or CNS names (if so, we hide Account Setup)
    const [_hasEnsKeys, _hasCnsKeys] = await Promise.all([
      Boolean(_userEns) && (await hasSetPublicKeys(_userEns as string, domainService.value)),
      Boolean(_userCns) && (await hasSetPublicKeys(_userCns as string, domainService.value)),
    ]);

    // Now we save the user's info to the store. We don't do this earlier because the UI is reactive based on these
    // parameters, and we want to ensure this method completed successfully before updating the UI
    relayer.value = _relayer;
    userAddress.value = _userAddress;
    userEns.value = _userEns;
    userCns.value = _userCns;
    network.value = _network;
    hasEnsKeys.value = _hasEnsKeys;
    hasCnsKeys.value = _hasCnsKeys;

    // Get token balances in the background. User may not be sending funds so we don't await this
    void getTokenBalances();
  }

  /**
   * @notice Prompts user for a signature to generate Umbra-specific private keys
   */
  async function getPrivateKeys() {
    if (!signer.value) throw new Error('No signer connected');
    if (!umbra.value) throw new Error('No Umbra instance available. Please make sure you are on a supported network');
    if (spendingKeyPair.value && viewingKeyPair.value) {
      return 'success';
    }

    try {
      const keyPairs = await umbra.value.generatePrivateKeys(signer.value);
      spendingKeyPair.value = keyPairs.spendingKeyPair;
      viewingKeyPair.value = keyPairs.viewingKeyPair;
      return 'success';
    } catch (err) {
      console.error(err);
      return 'denied'; // most likely user rejected the signature
    }
  }

  // ------------------------------------------ Mutations ------------------------------------------
  // Helper method to clear state. Useful when user switches wallets.
  function resetState() {
    userAddress.value = undefined;
    userEns.value = undefined;
    userCns.value = undefined;
    network.value = undefined;
    umbra.value = undefined;
    domainService.value = undefined;
    spendingKeyPair.value = undefined;
    viewingKeyPair.value = undefined;
    balances.value = {};
    relayer.value = undefined;
    hasEnsKeys.value = false;
    hasCnsKeys.value = false;
  }

  // ------------------------------------- Computed parameters -------------------------------------
  // "True" computed properties, i.e. derived from this module's state

  const isSupportedNetwork = computed(() => {
    if (!network.value) return true; // assume valid if we have no network information
    return supportedChainIds.includes(network.value.chainId);
  });

  const ETH_TOKEN = computed(() => {
    return { ...ETH_TOKEN_INFO, chainId: network.value?.chainId as number };
  });

  const tokens = computed(() => {
    // Add ETH as a supported token
    const supportedTokens = relayer.value?.tokens || [];
    return [ETH_TOKEN.value, ...supportedTokens];
  });

  const userDisplayName = computed(() => {
    // First try finding a domain name that has keys configured
    if (userEns.value && hasEnsKeys.value) return userEns.value;
    if (userCns.value && hasCnsKeys.value) return userCns.value;
    // If none are configured, just try a domain name
    if (userEns.value) return userEns.value;
    if (userCns.value) return userCns.value;
    // If no name service, just use a regular address
    return userAddress.value ? formatAddress(userAddress.value) : undefined;
  });

  const userDisplayAddress = computed(() => {
    // Format the regular address
    return userAddress.value ? formatAddress(userAddress.value) : undefined;
  });

  // ------------------------------------- Exposed parameters --------------------------------------
  // Define computed properties and parts of store that should be exposed. Everything exposed is a
  // computed property to facilitate reactivity and avoid accidental state mutations
  return {
    // Methods
    configureProvider,
    getPrivateKeys,
    getTokenBalances,
    setProvider,
    setHasEnsKeys: (status: boolean) => (hasEnsKeys.value = status),
    setHasCnsKeys: (status: boolean) => (hasCnsKeys.value = status),
    // "Direct" properties, i.e. return them directly without modification
    balances: computed(() => balances.value),
    domainService: computed(() => domainService.value),
    hasKeys: computed(() => spendingKeyPair.value?.privateKeyHex && viewingKeyPair.value?.privateKeyHex),
    network: computed(() => network.value),
    isAccountSetup: computed(() => hasEnsKeys.value || hasCnsKeys.value),
    provider: computed(() => provider.value),
    relayer: computed(() => relayer.value),
    signer: computed(() => signer.value),
    spendingKeyPair: computed(() => spendingKeyPair.value),
    umbra: computed(() => umbra.value),
    userAddress: computed(() => userAddress.value),
    userCns: computed(() => userCns.value),
    userEns: computed(() => userEns.value),
    viewingKeyPair: computed(() => viewingKeyPair.value),
    // "True" computed properties, i.e. derived from this module's state
    isSupportedNetwork: computed(() => isSupportedNetwork.value),
    ETH_TOKEN: computed(() => ETH_TOKEN.value),
    tokens: computed(() => tokens.value),
    userDisplayName: computed(() => userDisplayName.value),
    userDisplayAddress: computed(() => userDisplayAddress.value),
  };
}

// Helper method to check if user has ENS or CNS keys
const hasSetPublicKeys = async (name: string, domainService: DomainService) => {
  try {
    await domainService.getPublicKeys(name); // throws if no keys found
    return true;
  } catch (err) {
    console.warn(err);
    return false;
  }
};
