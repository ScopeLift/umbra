import '@nomiclabs/hardhat-ethers';
import * as chai from 'chai';
import { ethers } from 'hardhat';
import { default as Resolution, Eip1993Factories } from '@unstoppabledomains/resolution';
import * as cns from '../src/utils/cns';
import { expectRejection, registerCnsName } from './utils';

const { expect } = chai;
const ethersProvider = ethers.provider;

const resolution = new Resolution({
  sourceConfig: {
    cns: {
      provider: Eip1993Factories.fromEthersProvider(ethersProvider),
      network: 'rinkeby',
    },
  },
});

// Truth parameters to test against
const name = 'udtestdev-msolomon.crypto';
const nameSpendingPublicKey =
  '0x04f04b29a6ef7e7da9a2f2767c574c587b1d048c3cb0a7b29955175a35d8a2b345ebb852237b955d81e32a8c94ebd71704ccb4c8ab5b3ad5866543ca91ede825ef';
const nameViewingPublicKey =
  '0x04cc7d4c34d8f78e7bd65a04bea64bc21589073c139658040b4a20cc58991da385f0706d354b3aace6d1184e1e49ce2201dc884a3eb2b7f03a2d3a2bfbab10bd7d';

describe('СNS functions', () => {
  it('properly identifies CNS domains', () => {
    cns.supportedCnsDomains.forEach((suffix) => {
      // example suffixes: .crypto, .zil, etc.
      expect(cns.isCnsDomain(`test${suffix}`)).to.be.true;
    });
  });

  it('isCnsDomain returns false for empty CNS domains', () => {
    expect(cns.isCnsDomain('')).to.be.false;
  });

  it('throws when namehash is not given a string', () => {
    // @ts-expect-error
    expect(() => cns.namehash(123, resolution)).to.throw('Name must be a string');
  });

  it('throws when namehash is given a bad CNS suffix', () => {
    const badName = 'myname.com';
    const errorMsg = `Name ${badName} does not end with supported suffix: ${cns.supportedCnsDomains.join(', ')}`;
    expect(() => cns.namehash(badName, resolution)).to.throw(errorMsg);
  });

  it('computes the namehash of a CNS domain', () => {
    const hash = cns.namehash(name, resolution);
    expect(hash).to.equal('0xb523f834041c2aa484ca5f422d13e91a72ac459f925e26de7d63381bc26795f6');
  });

  it('gets the public keys associated with a CNS address', async () => {
    const publicKeys = await cns.getPublicKeys(name, ethersProvider, resolution);
    expect(publicKeys.spendingPublicKey).to.equal(nameSpendingPublicKey);
    expect(publicKeys.viewingPublicKey).to.equal(nameViewingPublicKey);
  });

  it('throws when the user has not set their stealth keys', async () => {
    // Arbitrary name that is registered but does not have keys on Rinkeby. If this test starts failing, a likely
    // culprit is that this name now has set stealth keys
    const unsetCnsName = 'udtestdev--c38898.crypto';
    const errorMsg = `Public keys not found for ${unsetCnsName}. User must setup their Umbra account`;
    await expectRejection(cns.getPublicKeys(unsetCnsName, ethersProvider, resolution), errorMsg);
  });

  it('sets the public keys', async () => {
    // First we get public keys, which should fail
    const user = (await ethers.getSigners())[0];
    const cnsLabel = 'umbrajs-test-name1';
    const cnsName = `udtestdev-${cnsLabel}.crypto`;
    const errorMsg = `Domain ${cnsName} is not registered`;
    await expectRejection(cns.getPublicKeys(cnsName, ethersProvider, resolution), errorMsg);

    // Register name
    await registerCnsName(cnsLabel, user);

    // Set the public keys
    await cns.setPublicKeys(cnsName, nameSpendingPublicKey, nameViewingPublicKey, ethersProvider, resolution);

    // Retrieve them and verify they match expected values
    const publicKeys = await cns.getPublicKeys(cnsName, ethersProvider, resolution);
    expect(publicKeys.spendingPublicKey).to.equal(nameSpendingPublicKey);
    expect(publicKeys.viewingPublicKey).to.equal(nameViewingPublicKey);
  });
});
