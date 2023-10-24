import { Contract, ContractFactory, Provider, Signer, Wallet } from 'zksync2-js';

import * as ethers from 'ethers';

import {
    HardhatRuntimeEnvironment
} from 'hardhat/types';

import { Address, DeploymentType } from 'zksync2-js/build/src/types';
import { FactoryOptions, ZkSyncArtifact } from './types';
import { ZkSync2JsPluginError } from './errors';
import { rich_wallets } from './rich-wallets';
import { getWalletsFromAccount, isArtifact, isFactoryOptions, isNumber, isString } from './utils';
import { ZKSOLC_ARTIFACT_FORMAT_VERSION, ZKVYPER_ARTIFACT_FORMAT_VERSION } from './constants';

export async function getWallet(hre: HardhatRuntimeEnvironment, privateKeyOrIndex?: string | number): Promise<Wallet> {
    const privateKey = isString(privateKeyOrIndex) ? (privateKeyOrIndex as string) : undefined;
    const accountNumber = isNumber(privateKeyOrIndex) ? (privateKeyOrIndex as number) : undefined;

    if (privateKey) {
        return new Wallet(privateKey, hre.zksync2js.provider);
    }

    const accounts = hre.network.config.accounts;

    const wallets = await getWalletsFromAccount(hre, accounts);

    if (accountNumber && accountNumber >= wallets.length) {
        throw new ZkSync2JsPluginError('Account private key with specified index is not found');
    }

    if (wallets.length == 0) {
        throw new ZkSync2JsPluginError('Accounts are not configured for this network');
    }

    return wallets[accountNumber || 0];
}

export async function getWallets(hre: HardhatRuntimeEnvironment): Promise<Wallet[]> {
    const accounts = hre.network.config.accounts;

    return await getWalletsFromAccount(hre, accounts);
}

function getSigners(hre: HardhatRuntimeEnvironment): Signer[] {
    const accounts: string[] = rich_wallets.map((wallet) => wallet.address);

    const signersWithAddress = accounts.map((account) => getSigner(hre, account));

    return signersWithAddress;
}

function getSigner(hre: HardhatRuntimeEnvironment, address: string): Signer {
    return Signer.from(new Signer(hre.zksync2js.provider, address), hre.network.config.chainId);
}

export async function getImpersonatedSigner(hre: HardhatRuntimeEnvironment, address: string): Promise<Signer> {
    await hre.zksync2js.provider.send('hardhat_impersonateAccount', [address]);
    return getSigner(hre, address);
}

export async function getContractFactory(
    hre: HardhatRuntimeEnvironment,
    name: string,
    walletOrOption?: Wallet | FactoryOptions
): Promise<ContractFactory>;

export async function getContractFactory(
    hre: HardhatRuntimeEnvironment,
    abi: any[],
    bytecode: ethers.BytesLike,
    wallet?: Wallet,
    deploymentType?: DeploymentType
): Promise<ContractFactory>;

export async function getContractFactory(
    hre: HardhatRuntimeEnvironment,
    nameOrAbi: string | any[],
    bytecodeOrFactoryOptions?: (Wallet | FactoryOptions) | ethers.BytesLike,
    wallet?: Wallet,
    deploymentType?: DeploymentType
): Promise<ContractFactory> {
    if (typeof nameOrAbi === 'string') {
        const artifact = await loadArtifact(hre, nameOrAbi);

        return getContractFactoryFromArtifact(
            hre,
            artifact,
            bytecodeOrFactoryOptions as Wallet | FactoryOptions | undefined,
            deploymentType
        );
    }

    return getContractFactoryByAbiAndBytecode(
        hre,
        nameOrAbi,
        bytecodeOrFactoryOptions as ethers.BytesLike,
        wallet,
        deploymentType
    );
}

export async function getContractFactoryFromArtifact(
    hre: HardhatRuntimeEnvironment,
    artifact: ZkSyncArtifact,
    walletOrOptions?: Wallet | FactoryOptions,
    deploymentType?: DeploymentType
): Promise<ContractFactory> {
    let wallet: Wallet | undefined;

    if (!isArtifact(artifact)) {
        throw new ZkSync2JsPluginError(
            `You are trying to create a contract factory from an artifact, but you have not passed a valid artifact parameter.`
        );
    }

    if (isFactoryOptions(walletOrOptions)) {
        wallet = walletOrOptions.wallet;
    } else {
        wallet = walletOrOptions;
    }

    if (artifact.bytecode === '0x') {
        throw new ZkSync2JsPluginError(
            `You are trying to create a contract factory for the contract ${artifact.contractName}, which is abstract and can't be deployed.
If you want to call a contract using ${artifact.contractName} as its interface use the "getContractAt" function instead.`
        );
    }

    return getContractFactoryByAbiAndBytecode(hre, artifact.abi, artifact.bytecode, wallet, deploymentType);
}

async function getContractFactoryByAbiAndBytecode(
    hre: HardhatRuntimeEnvironment,
    abi: any[],
    bytecode: ethers.BytesLike,
    wallet?: Wallet,
    deploymentType?: DeploymentType
): Promise<ContractFactory> {
    if (!wallet) {
        wallet = await getWallet(hre);
    }

    return new ContractFactory(abi, bytecode, wallet, deploymentType);
}

export async function getContractAt(
    hre: HardhatRuntimeEnvironment,
    nameOrAbi: string | any[],
    address: string | Address,
    wallet?: Wallet
): Promise<Contract> {
    if (typeof nameOrAbi === 'string') {
        const artifact = await loadArtifact(hre, nameOrAbi);

        return getContractAtFromArtifact(hre, artifact, address, wallet);
    }

    if (!wallet) {
        wallet = await getWallet(hre);
    }

    // If there's no signer, we want to put the provider for the selected network here.
    // This allows read only operations on the contract interface.
    const walletOrProvider: Wallet | Provider = wallet !== undefined ? wallet : hre.zksync2js.provider;

    return new Contract(address, nameOrAbi, walletOrProvider);
}

export async function getContractAtFromArtifact(
    hre: HardhatRuntimeEnvironment,
    artifact: ZkSyncArtifact,
    address: string | Address,
    wallet?: Wallet
): Promise<Contract> {
    if (!isArtifact(artifact)) {
        throw new ZkSync2JsPluginError(
            `You are trying to create a contract by artifact, but you have not passed a valid artifact parameter.`
        );
    }

    if (!wallet) {
        wallet = await getWallet(hre);
    }

    let contract = new Contract(address, artifact.abi, wallet);

    if (contract.runner === null) {
        contract = contract.connect(hre.zksync2js.provider) as Contract;
    }

    return contract;
}

export async function deployContract(
    hre: HardhatRuntimeEnvironment,
    artifact: ZkSyncArtifact,
    wallet?: Wallet,
    constructorArguments: any[] = [],
    overrides?: ethers.Overrides,
    additionalFactoryDeps?: ethers.BytesLike[]
): Promise<Contract> {
    if (!wallet) {
        wallet = await getWallet(hre);
    }

    const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);

    const baseDeps = await extractFactoryDeps(hre, artifact);
    const additionalDeps = additionalFactoryDeps ? additionalFactoryDeps.map((val) => ethers.hexlify(val)) : [];
    const factoryDeps = [...baseDeps, ...additionalDeps];

    const { customData, ..._overrides } = overrides ?? {};

    // Encode and send the deploy transaction providing factory dependencies.
    const contract = await factory.deploy(...constructorArguments, {
        ..._overrides,
        customData: {
            ...customData,
            salt: ethers.ZeroHash,
            factoryDeps,
        },
    });

    await contract.waitForDeployment();

    return contract as Contract;
}

export async function loadArtifact(
    hre: HardhatRuntimeEnvironment,
    contractNameOrFullyQualifiedName: string
): Promise<ZkSyncArtifact> {
    const artifact = await hre.artifacts.readArtifact(contractNameOrFullyQualifiedName);

    // Verify that this artifact was compiled by the zkSync compiler, and not `solc` or `vyper`.
    if (artifact._format !== ZKSOLC_ARTIFACT_FORMAT_VERSION && artifact._format !== ZKVYPER_ARTIFACT_FORMAT_VERSION) {
        throw new ZkSync2JsPluginError(
            `Artifact ${contractNameOrFullyQualifiedName} was not compiled by zksolc or zkvyper`
        );
    }
    return artifact as ZkSyncArtifact;
}

export async function extractFactoryDeps(hre: HardhatRuntimeEnvironment, artifact: ZkSyncArtifact): Promise<string[]> {
    const visited = new Set<string>();
    visited.add(`${artifact.sourceName}:${artifact.contractName}`);
    return await extractFactoryDepsRecursive(hre, artifact, visited);
}

async function extractFactoryDepsRecursive(
    hre: HardhatRuntimeEnvironment,
    artifact: ZkSyncArtifact,
    visited: Set<string>
): Promise<string[]> {
    // Load all the dependency bytecodes.
    // We transform it into an array of bytecodes.
    const factoryDeps: string[] = [];
    for (const dependencyHash in artifact.factoryDeps) {
        const dependencyContract = artifact.factoryDeps[dependencyHash];
        if (!visited.has(dependencyContract)) {
            const dependencyArtifact = await loadArtifact(hre, dependencyContract);
            factoryDeps.push(dependencyArtifact.bytecode);
            visited.add(dependencyContract);
            const transitiveDeps = await extractFactoryDepsRecursive(hre, dependencyArtifact, visited);
            factoryDeps.push(...transitiveDeps);
        }
    }

    return factoryDeps;
}
