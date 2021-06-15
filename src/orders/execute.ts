import { ChainId } from "@sushiswap/sdk";
import { BigNumber, ethers, providers } from "ethers";
import { FillLimitOrder, getAdvancedReceiver, LimitOrder } from "limitorderv2-sdk";
import { IExecutedOrder } from "../models/models";
import { ExecutableOrder, getGweiGasPrice } from "./profitability";
import DEFAULT_TOKEN_LIST from '@sushiswap/default-token-list';
import { _desiredProfitToken } from '../relayer-config/pairs';
import { MyProvider } from "../utils/provider";
import { MyLogger } from "../utils/myLogger";

export async function executeOrders(ordersData: ExecutableOrder[]): Promise<IExecutedOrder[]> {

  const executed: IExecutedOrder[] = [];

  await Promise.all(ordersData.map(async executableOrder => {

    const order = executableOrder.limitOrderData.order;

    const keepTokenIn = ExecuteHelper.Instance.keepTokenIn(executableOrder.limitOrderData.order.tokenIn, executableOrder.limitOrderData.order.tokenOut);

    let amountExternal: BigNumber;

    if (keepTokenIn) {
      const inDiff = executableOrder.inAmount.sub(executableOrder.minAmountIn).div(10);
      amountExternal = executableOrder.minAmountIn.add(inDiff); // 10% of profit as slippage
    } else {
      amountExternal = executableOrder.outAmount.sub(executableOrder.outDiff.div(10)); // 10% of profit as slippage
    }

    const fillOrder = new FillLimitOrder(
      LimitOrder.getLimitOrder(order),
      [order.tokenIn, order.tokenOut],
      amountExternal,
      executableOrder.inAmount,
      getAdvancedReceiver(ChainId.MATIC),
      process.env.PROFIT_RECEIVER_ADDRESS,
      keepTokenIn
    );

    const wallet = MyProvider.Instance.wallet;

    const gasPrice = await getGweiGasPrice(+process.env.CHAINID);

    if (!gasPrice) return;

    const alreadyExecuted = ExecuteHelper.Instance.alreadyExecuted(executableOrder.limitOrderData.digest);

    if (!alreadyExecuted) {

      const fillStatus = await fillOrder.fillOrder(wallet, { forceExecution: false, gasPrice: gasPrice, open: false });

      if (fillStatus.executed) {

        executed.push({
          order: executableOrder.limitOrderData.order,
          digest: executableOrder.limitOrderData.digest,
          fillAmount: executableOrder.inAmount.toString(),
          txHash: fillStatus.transactionHash,

        });

        MyLogger.log(`${fillStatus.transactionHash}, gasPrice: ${gasPrice.toString()}`);

      } else {

        ExecuteHelper.Instance.remove(executableOrder.limitOrderData.digest);
        MyLogger.log("Gas estimation failed");

      }

    } else {

      console.log('Order already executing');

    }

  }));

  return executed;
}

export class ExecuteHelper {

  private executedOrders: Array<{ timestamp: number, digest: string }> = [];

  private timeBuffer = 1000 * 180; // 5 min

  public readonly profitTokens: string[];

  private static _instance: ExecuteHelper;

  public static get Instance() {
    return this._instance || (this._instance = new this());
  }

  protected constructor() {

    const tokens = DEFAULT_TOKEN_LIST.tokens.filter(token => token.chainId === +process.env.CHAINID);

    this.profitTokens = _desiredProfitToken.map(tokenSymbol => tokens.find(token => token.symbol === tokenSymbol).address).reverse();

    if (this.profitTokens.indexOf(undefined) !== -1) console.log(`Error! Couldn't find profit token`);

  };

  alreadyExecuted(digest: string) {

    this.executedOrders = this.executedOrders.filter(o => o.timestamp + this.timeBuffer > new Date().getTime());

    const alreadyExecuted = this.executedOrders.some(o => o.digest === digest);

    if (!alreadyExecuted) {

      this.executedOrders.push({
        timestamp: new Date().getTime(),
        digest,
      });

    }

    return alreadyExecuted;

  }

  remove(digest: string) {

    this.executedOrders = this.executedOrders.filter(o => o.digest !== digest);

  }

  // given two token addressed figure out which one we want to keep profit in
  keepTokenIn(tokenIn: string, tokenOut: string) {
    return this.profitTokens.indexOf(tokenIn) > this.profitTokens.indexOf(tokenOut);
  }

}