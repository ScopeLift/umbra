<template>
  <div @click="connectWallet">
    <slot></slot>
  </div>
</template>

<script lang="ts">
import { defineComponent, SetupContext } from '@vue/composition-api';
import { Dark } from 'quasar';
import useSettingsStore from 'src/store/settings';
import useWalletStore from 'src/store/wallet';
import Onboard from 'bnc-onboard';

function useWallet(context: SetupContext, to: string) {
  const { setProvider, configureProvider, userAddress } = useWalletStore();
  const { setLastWallet } = useSettingsStore();

  async function connectWallet() {
    // If user already connected wallet, continue (this branch is used when clicking e.g. the "Send" box
    // from the home page)
    if (userAddress.value && to) {
      await context.root.$router.push({ name: to });
      return;
    }

    // Otherwise, prompt them for connection / wallet change
    const rpcUrl = `https://mainnet.infura.io/v3/${String(process.env.INFURA_ID)}`;
    const wallets = [
      { walletName: 'metamask', preferred: true },
      { walletName: 'walletConnect', infuraKey: process.env.INFURA_ID, preferred: true },
      { walletName: 'fortmatic', apiKey: process.env.FORTMATIC_API_KEY, preferred: true },
      { walletName: 'portis', apiKey: process.env.PORTIS_API_KEY },
      { walletName: 'ledger', rpcUrl },
      { walletName: 'torus', preferred: true },
      { walletName: 'lattice', rpcUrl, appName: 'Umbra' },
      { walletName: 'opera' },
    ];
    const walletChecks = [{ checkName: 'connect' }];

    const onboard = Onboard({
      dappId: process.env.BLOCKNATIVE_API_KEY,
      darkMode: Dark.isActive,
      networkId: 1,
      walletSelect: { wallets },
      walletCheck: walletChecks,
      subscriptions: {
        wallet: (wallet) => {
          setProvider(wallet.provider);
          if (wallet.name) setLastWallet(wallet.name);
        },
      },
    });

    // Clear existing wallet selection
    onboard.walletReset();

    // Connect wallet
    await onboard.walletSelect();
    await onboard.walletCheck();

    // Finish setup
    await configureProvider(); // get ENS name, CNS names, etc.
    if (to) await context.root.$router.push({ name: to }); // redirect to specified page
  }

  return { connectWallet };
}

export default defineComponent({
  name: 'ConnectWallet',

  props: {
    // Page name to redirect to after logging in
    to: {
      type: String,
      required: false,
      default: undefined,
    },
  },

  setup(props, context) {
    return { ...useWallet(context, props.to) };
  },
});
</script>
