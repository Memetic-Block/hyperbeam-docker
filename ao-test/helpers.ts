import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createData, Signer, EthereumSigner } from '@dha-team/arbundles'

export function loadWallet (path: string) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf-8'))
  } catch (err) {
    console.error(`Error: Could not read wallet from ${path}: ${err.message}`)
    process.exit(1)
  }
}

/**
 * Resolve the node's operator address — the default scheduler AND authority
 * for spawns against a lua-compute node. (Unlike the legacy genesis-wasm
 * setup there is no separate `genesis-wasm-import-authorities` list to
 * consult: the lua device computes whatever the node schedules.)
 */
export async function resolveAuthority (url: string) {
  if (process.env.AUTHORITY) return process.env.AUTHORITY
  const res = await fetch(`${url}/~meta@1.0/info/address`)
  if (!res.ok) throw new Error(`Failed to resolve authority from ${url}: ${res.status}`)
  return res.text()
}

export async function createEthereumDataItemSigner (signer: Signer) {
  return (
    { data, tags, target, anchor }: {
      data: string | Uint8Array,
      tags: any[],
      target?: string,
      anchor?: string
    }
  ) => {
    const dataItem = createData(data || 'AnyoneProtocol', signer, { tags, target, anchor })

    return dataItem.sign(signer).then(async () => ({
      id: await dataItem.id,
      raw: await dataItem.getRaw()
    }))
  }
}

export async function createEthSigner (ethSigner: EthereumSigner) {
  try {
    const publicKey = Buffer.from(ethSigner.publicKey)
    const signerAddress = publicKey.toString('base64url')
    return async (create: (...args: any[]) => Promise<Uint8Array>, kind: 'ans104' | 'httpsig') => {
      if (kind === 'ans104' || kind === 'httpsig') {
        const signatureBase = await create({
          type: ethSigner.signatureType,
          publicKey,
          alg: 'ethereum',
        })

        const signature = await ethSigner.sign(signatureBase)

        return {
          signature: Buffer.from(signature),
          address: signerAddress,
        }
      }
      throw new Error(`Unknown signer kind: ${kind}`)
    }
  } catch (e) {
    console.error('Failed to create Ethereum signer: ' + e.message)
    return null
  }
}
