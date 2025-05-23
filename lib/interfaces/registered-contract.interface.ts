import { ethers } from 'ethers';

export interface RegisteredContract {
  address: string;
  abi: ethers.InterfaceAbi;
  callback: (
    parsedLog: ethers.LogDescription | null,
    rawLog: ethers.Log,
    eventName: string,
  ) => Promise<void> | void;
  eventNames?: string[];
}
