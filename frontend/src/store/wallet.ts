import { computed, onMounted, ref } from '@vue/composition-api';
import { BigNumber, Contract, Web3Provider } from 'src/utils/ethers';
import { DomainService, KeyPair, Umbra } from '@umbra/umbra-js';
import {
  Signer,
  Provider,
  Network,
  TokenInfo,
  TokenList,
  MulticallResponse,
  SupportedChainIds,
} from 'components/models';
import Multicall from 'src/contracts/Multicall.json';
import ERC20 from 'src/contracts/ERC20.json';
import { formatAddress, lookupEnsName, lookupCnsName } from 'src/utils/address';

/**
 * State is handled in reusable components, where each component is its own self-contained
 * file consisting of one function defined used the composition API.
 *
 * Since we want the wallet state to be shared between all instances when this file is imported,
 * we defined state outside of the function definition.
 */

const jsonFetch = (url: string) => fetch(url).then((res) => res.json());
const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ETH_TOKEN = {
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  name: 'Ether',
  symbol: 'ETH',
  decimals: 18,
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
const userDisplayName = ref<string>(); // user's ENS or CNS or wallet address to display
const userEns = ref<string>(); // user's ENS name
const userCns = ref<string>(); // user's CNS name
const network = ref<Network>(); // connected network, derived from provider
const umbra = ref<Umbra>(); // instance of Umbra class
const domainService = ref<DomainService>(); // instance DomainService class
const spendingKeyPair = ref<KeyPair>(); // KeyPair instance, with private key, for spending receiving funds
const viewingKeyPair = ref<KeyPair>(); // KeyPair instance, with private key, for scanning for received funds
const tokens = ref<TokenInfo[]>([]); // list of supported tokens when scanning
const balances = ref<Record<string, BigNumber>>({}); // mapping from token address to user's wallet balance

// ========================================== Main Store ===========================================
export default function useWalletStore() {
  onMounted(() => void getTokenList()); // dispatch in the background to get token details

  // ------------------------------------------- Actions -------------------------------------------
  async function getTokenList() {
    if (tokens.value.length > 0) return;
    if (provider.value?.network.chainId === 1) {
      // Mainnet
      const url = 'https://tokens.coingecko.com/uniswap/all.json';
      const response = (await jsonFetch(url)) as TokenList;
      tokens.value = response.tokens;
      tokens.value.push({ chainId: 1, ...ETH_TOKEN });
    } else {
      // Rinkeby
      tokens.value = [
        { chainId: 4, ...ETH_TOKEN },
        // prettier-ignore
        { chainId: 4, address: '0x2e055eEe18284513B993dB7568A592679aB13188', name: 'Dai', symbol: 'DAI', decimals: 18, logoURI: 'https://assets.coingecko.com/coins/images/9956/thumb/dai-multi-collateral-mcd.png?1574218774', },
        // prettier-ignore
        { chainId: 4, address: '0xeb8f08a975Ab53E34D8a0330E0D34de942C95926', name: 'USD Coin', symbol: 'USDC', decimals: 6, logoURI: 'https://assets.coingecko.com/coins/images/6319/thumb/USD_Coin_icon.png?1547042389', },
      ];
    }
  }

  async function getTokenBalances() {
    // Setup
    if (!provider.value) throw new Error('Provider not connected');
    await getTokenList(); // does nothing if we already have the list
    const chainId = String(provider.value.network.chainId) as SupportedChainIds;
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
    const _userAddress = await signer.value.getAddress();
    const _network = await provider.value.getNetwork();

    // Get ENS and CNS names
    const _userEns = await lookupEnsName(_userAddress, provider.value);
    const _userCns = await lookupCnsName(_userAddress, provider.value);

    // Set Umbra and DomainService classes
    const chainId = provider.value.network.chainId;
    umbra.value = new Umbra(provider.value, chainId);
    domainService.value = new DomainService(provider.value);

    // Now we save the user's info to the store. We don't do this earlier because the UI is reactive based on these
    // parameters, and we want to ensure this method completed successfully before updating the UI
    userAddress.value = _userAddress;
    userEns.value = _userEns;
    userCns.value = _userCns;
    network.value = _network;
    userDisplayName.value = _userEns || _userCns || formatAddress(_userAddress);

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

  // ------------------------------------- Exposed parameters --------------------------------------
  // Define parts of store that should be exposed
  return {
    provider: computed(() => provider.value),
    signer: computed(() => signer.value),
    userAddress: computed(() => userAddress.value),
    userDisplayName: computed(() => userDisplayName.value),
    userEns: computed(() => userEns.value),
    userCns: computed(() => userCns.value),
    network: computed(() => network.value),
    tokens: computed(() => tokens.value),
    balances: computed(() => balances.value),
    umbra: computed(() => umbra.value),
    domainService: computed(() => domainService.value),
    spendingKeyPair: computed(() => spendingKeyPair.value),
    viewingKeyPair: computed(() => viewingKeyPair.value),
    hasKeys: computed(() => spendingKeyPair.value?.privateKeyHex && viewingKeyPair.value?.privateKeyHex),
    getTokenList,
    getTokenBalances,
    setProvider,
    configureProvider,
    getPrivateKeys,
  };
}
