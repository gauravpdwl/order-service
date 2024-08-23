import express, { Request, Response } from "express";
import cors from 'cors';
import { globalErrorHandler } from "./common/middleware/globalErrorHandler";
import cookieParser from "cookie-parser";
import customerRouter from "./customer/customerRouter";
import couponRouter from "./coupon/couponRouter";
import orderRouter from "./order/orderRouter";

const app = express();

 // Use CORS middleware
 app.use(cors({
  origin:["http://localhost:8000"],
  credentials: true
}));

app.use(cookieParser());
app.use(express.json());
app.get("/", (req: Request, res: Response) => {
  res.json({ message: "Hello from order service service!" });
});

app.use("/customer", customerRouter);
app.use("/coupons", couponRouter);
app.use("/orders", orderRouter)

app.use(globalErrorHandler);

export default app;