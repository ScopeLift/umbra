/**
 * @dev Wraps ENS and CNS into a common interface
 */

import { default as Resolution, Eip1993Factories } from '@unstoppabledomains/resolution';
import { EthersProvider } from '../types';
import * as cns from '../utils/cns';
import * as ens from '../utils/ens';

export class DomainService {
  // Resolution instance of @unstoppabledomains/resolution
  readonly udResolution: Resolution;

  /**
   * @dev You may need to call `await provider.getNetwork()` before passing in the provider to ensure the network
   * property exists
   * @param provider ethers provider instance
   */
  constructor(readonly provider: EthersProvider) {
    // If network name is homestead, use 'mainnet' as the network name
    const networkName = provider.network.name === 'homestead' ? 'mainnet' : provider.network.name;
    this.udResolution = new Resolution({
      sourceConfig: {
        cns: {
          provider: Eip1993Factories.fromEthersProvider(provider),
          network: networkName as 'mainnet' | 'rinkeby',
        },
      },
    });
  }

  /**
   * @notice Computes namehash of the input domain, normalized to ENS or CNS compatibility
   * @param name domain, e.g. myname.eth
   */
  namehash(name: string) {
    if (ens.isEnsDomain(name)) {
      return ens.namehash(name);
    } else {
      return cns.namehash(name, this.udResolution);
    }
  }

  /**
   * @notice For a given domain, recovers and returns the public key from its signature
   * @param name domain, e.g. myname.eth
   */
  async getPublicKeys(name: string) {
    if (ens.isEnsDomain(name)) {
      return ens.getPublicKeys(name, this.provider);
    } else {
      return cns.getPublicKeys(name, this.provider, this.udResolution);
    }
  }

  /**
   * @notice For a given domain, sets the associated umbra public keys
   * @param name domain, e.g. myname.eth
   * @param spendingPublicKey The public key for generating a stealth address as hex string
   * @param viewingPublicKey The public key to use for encryption as hex string
   * @returns Transaction hash
   */
  async setPublicKeys(name: string, spendingPublicKey: string, viewingPublicKey: string) {
    if (ens.isEnsDomain(name)) {
      return ens.setPublicKeys(name, spendingPublicKey, viewingPublicKey, this.provider);
    } else {
      return cns.setPublicKeys(name, spendingPublicKey, viewingPublicKey, this.provider, this.udResolution);
    }
  }
}
