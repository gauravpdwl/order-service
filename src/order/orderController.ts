import { NextFunction, Request, Response } from "express";
import { Request as AuthRequest } from "express-jwt";
import {
  CartItem,
  ProductPricingCache,
  Topping,
  ToppingPriceCache,
} from "../types";
import productCacheModel from "../productCache/productCacheModel";
import toppingCacheModel from "../toppingCache/toppingCacheModel";
import couponModel from "../coupon/couponModel";
import orderModel from "./orderModel";
import { OrderStatus, PaymentMode, PaymentStatus } from "./orderTypes";
import mongoose from "mongoose";
import idempotencyModel from "../idempotency/idempotencyModel";
import createHttpError from "http-errors";
import { PaymentGW } from "../payment/paymentTypes";
import { MessageBroker } from "../types/broker";
import customerModel from "../customer/customerModel";

export class OrderController {

  constructor(private paymentGw: PaymentGW, private broker: MessageBroker) {}

  create = async (req: Request, res: Response, next: NextFunction) => {

    const {
      cart,
      couponCode,
      tenantId,
      paymentMode,
      customerId,
      comment,
      address,
    } = req.body;

    // todo: validate request data.

    // console.log("req info -> ", req.body);

    // await this.gcalculateTotal(req.body.cart);

    const totalPrice = await this.calculateTotal(cart);

    let discountPercentage = 0;

    if (couponCode) {
      discountPercentage = await this.getDiscountPercentage(
        couponCode,
        tenantId,
      );
    }

    const discountAmount = Math.round((totalPrice * discountPercentage) / 100);

    const priceAfterDiscount = totalPrice - discountAmount;

    // todo: May be store in db for each tenant.
    const TAXES_PERCENT = 18;

    const taxes = Math.round((priceAfterDiscount * TAXES_PERCENT) / 100);

    // todo: may be store in database for each tenant or maybe calculated according to business rules.
    const DELIVERY_CHARGES = 100;

    const finalTotal = priceAfterDiscount + taxes + DELIVERY_CHARGES;

    const idempotencyKey = req.headers["idempotency-key"];

    const idempotency = await idempotencyModel.findOne({ key: idempotencyKey });

    let newOrder = idempotency ? [idempotency.response] : [];

    if (!idempotency) {
      const session = await mongoose.startSession();
      await session.startTransaction();

      try {
        newOrder = await orderModel.create(
          [
            {
              cart,
              address,
              comment,
              customerId,
              deliveryCharges: DELIVERY_CHARGES,
              discount: discountAmount,
              taxes,
              tenantId,
              total: finalTotal,
              paymentMode,
              orderStatus: OrderStatus.RECEIVED,
              paymentStatus: PaymentStatus.PENDING,
            },
          ],
          { session },
        );

        await idempotencyModel.create(
          [{ key: idempotencyKey, response: newOrder[0] }],
          { session },
        );

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        await session.endSession();

        return next(createHttpError(500, err.message));
      } finally {
        await session.endSession();
      }
    }

     // todo: Error handling...
    // todo: add logging
    if (paymentMode === PaymentMode.CARD) {
      const session = await this.paymentGw.createSession({
        amount: finalTotal,
        orderId: newOrder[0]._id.toString(),
        tenantId: tenantId,
        currency: "inr",
        idempotenencyKey: idempotencyKey as string,
      });

      await this.broker.sendMessage("order", JSON.stringify(newOrder));

      return res.json({ paymentUrl: session.paymentUrl });
    }

    await this.broker.sendMessage("order", JSON.stringify(newOrder));

    // todo: Update order document -> paymentId -> sessionId
    return res.json({ paymentUrl: null });
  };

  getMine = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.auth.sub;

    if (!userId) {
      return next(createHttpError(400, "No userId found."));
    }

    // todo: Add error handling.
    const customer = await customerModel.findOne({ userId });

    if (!customer) {
      return next(createHttpError(400, "No customer found."));
    }

    // todo: implement pagination.
    const orders = await orderModel.find(
      { customerId: customer._id },
      { cart: 0 },
    );

    return res.json(orders);
  };

  getSingle = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const orderId = req.params.orderId;
    const { sub: userId, role, tenant: tenantId } = req.auth;
    
    const fields = req.query.fields
      ? req.query.fields.toString().split(",")
      : []; // ["orderStatus", "paymentStatus"]

    const projection = fields.reduce((acc, field) => {
      acc[field] = 1;
      return acc;
    }, {});

    // {
    //   orderStatus: 1,
    //   PaymentStatus: 1,
    // }

    const order = await orderModel.findOne({ _id: orderId }, projection);

    if (!order) {
      return next(createHttpError(400, "Order does not exists."));
    }

    // What roles can access this endpoint: Admin, manager (for their own restaurant), customer (own order)
    if (role === "admin") {
      return res.json(order);
    }

    const myRestaurantOrder = order.tenantId === tenantId;
    if (role === "manager" && myRestaurantOrder) {
      return res.json(order);
    }

    if (role === "customer") {
      const customer = await customerModel.findOne({ userId });
      console.log("customer", customer);
      if (!customer) {
        return next(createHttpError(400, "No customer found."));
      }

      if (order.customerId.toString() === customer._id.toString()) {
        return res.json(order);
      }
    }

    return next(createHttpError(403, "Operation not permitted."));
  };

  private getDiscountPercentage = async (
    couponCode: string,
    tenantId: string,
  ) => {
    const code = await couponModel.findOne({ code: couponCode, tenantId });

    if (!code) {
      return 0;
    }

    const currentDate = new Date();
    const couponDate = new Date(code.validUpto);

    if (currentDate <= couponDate) {
      return code.discount;
    }

    return 0;
  };

  private gcalculateTotal = async (cart: CartItem[])=>{
    
    const productIds=cart.map((item)=> item._id);

    const productPricings=await productCacheModel.find({
        productId : {
            $in: productIds,
        }
    })

    // console.log("product pricing -> ", productPricings);

    // product pricing ->  [
    //     {
    //       _id: new ObjectId('66c840f1561a5da41fef60b4'),
    //       productId: '66c840f0a6fc830cdcf9c9df',
    //       __v: 0,
    //       priceConfiguration: { Size: [Object], Crust: [Object] }
    //     }
    //   ]

    const toppingIds=cart.reduce((acc, item)=>{
        return [
            ...acc,
            ...item.chosenConfiguration.selectedToppings.map((topping)=>topping.id)
        ]
    },[])

    const toppingPricings= await toppingCacheModel.find({
        toppingId:{
            $in: toppingIds
        }
    })

    // console.log("topping pricings -> ",toppingPricings)

    // topping pricings ->  [
    //     {
    //       _id: new ObjectId('66c856f7561a5da41fef68f8'),
    //       toppingId: '66c856f3faa203f0fd697ddc',
    //       __v: 0,
    //       createdAt: 2024-08-23T09:31:35.556Z,
    //       price: 25,
    //       tenantId: '3',
    //       updatedAt: 2024-08-23T09:31:35.556Z
    //     }
    //   ]

    let totalPrice: number = 0;
    // product price
    cart.map((item)=>{

        let productPrice: number = 0;
        let toppingPrice: number = 0;

        Object.entries(item.chosenConfiguration.priceConfiguration).map(([key, value])=>{
            const selectedProduct=productPricings.filter((product)=>product.productId===item._id)

            Object.entries(selectedProduct[0].priceConfiguration).map(([ky, val])=>{
                if(ky===key){
                    Object.entries(val.availableOptions).map(([aok, aov] : [string, number])=>{
                        if(aok===value){
                            productPrice=productPrice+aov;
                        }
                    }) 
                }
            })

        })

        item.chosenConfiguration.selectedToppings.map((item)=>{
            const selectedTopping = toppingPricings.filter((topping)=>topping.toppingId===item.id);
            toppingPrice = toppingPrice + selectedTopping[0].price;
        })

        totalPrice= totalPrice + (productPrice + toppingPrice) * item.qty; 
    })

    console.log("Total Price", totalPrice);
  }

  private calculateTotal = async (cart: CartItem[]) => {
    const productIds = cart.map((item) => item._id);

    // todo: proper error handling..
    const productPricings = await productCacheModel.find({
      productId: {
        $in: productIds,
      },
    });

    // todo: What will happen if product does not exists in the cache
    // 1. call catalog service.
    // 2. Use price from cart <- BAD

    const cartToppingIds = cart.reduce((acc, item) => {
      return [
        ...acc,
        ...item.chosenConfiguration.selectedToppings.map(
          (topping) => topping.id,
        ),
      ];
    }, []);

    // todo: What will happen if topping does not exists in the cache
    const toppingPricings = await toppingCacheModel.find({
      toppingId: {
        $in: cartToppingIds,
      },
    });

    const totalPrice = cart.reduce((acc, curr) => {
      const cachedProductPrice = productPricings.find(
        (product) => product.productId === curr._id,
      );

      return (
        acc +
        curr.qty * this.getItemTotal(curr, cachedProductPrice, toppingPricings)
      );
    }, 0);

    return totalPrice;
  };

  private getItemTotal = (
    item: CartItem,
    cachedProductPrice: ProductPricingCache,
    toppingsPricings: ToppingPriceCache[],
  ) => {
    const toppingsTotal = item.chosenConfiguration.selectedToppings.reduce(
      (acc, curr) => {
        return acc + this.getCurrentToppingPrice(curr, toppingsPricings);
      },
      0,
    );

    const productTotal = Object.entries(
      item.chosenConfiguration.priceConfiguration,
    ).reduce((acc, [key, value]) => {
      const price =
        cachedProductPrice.priceConfiguration[key].availableOptions[value];
      return acc + price;
    }, 0);

    return productTotal + toppingsTotal;
  };

  private getCurrentToppingPrice = (
    topping: Topping,
    toppingPricings: ToppingPriceCache[],
  ) => {
    const currentTopping = toppingPricings.find(
      (current) => topping.id === current.toppingId,
    );

    if (!currentTopping) {
      // todo: Make sure the item is in the cache else, maybe call catalog service.
      return topping.price;
    }

    return currentTopping.price;
  };
}