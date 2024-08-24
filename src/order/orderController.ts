import { Request, Response } from "express";
import {
  CartItem,
  ProductPricingCache,
  Topping,
  ToppingPriceCache,
} from "../types";
import productCacheModel from "../productCache/productCacheModel";
import toppingCacheModel from "../toppingCache/toppingCacheModel";

export class OrderController {
  create = async (req: Request, res: Response) => {
    // todo: validate request data.

    // console.log("req info -> ", req.body);

    // await this.gcalculateTotal(req.body.cart);

    const totalPrice = await this.calculateTotal(req.body.cart);

    return res.json({ totalPrice: totalPrice });
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