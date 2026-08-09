import { BaseError, ContractFunctionRevertedError } from "viem";
import { CONTRACT_ERROR_MESSAGES } from "./contracts";

/** Walks a viem contract-call error to find the real decoded Solidity custom-error name, then
 *  maps it to a human message from CONTRACT_ERROR_MESSAGES — never a generic "transaction
 *  failed," since every custom error in our ABIs is named and meaningful. */
export function decodeContractError(err: unknown): { name: string | null; message: string } {
  if (err instanceof BaseError) {
    const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      const name = revertError.data?.errorName ?? null;
      if (name && CONTRACT_ERROR_MESSAGES[name]) {
        return { name, message: CONTRACT_ERROR_MESSAGES[name] };
      }
      if (name) return { name, message: `On-chain error: ${name}` };
    }
    return { name: null, message: err.shortMessage ?? err.message };
  }
  return { name: null, message: err instanceof Error ? err.message : String(err) };
}
