import express, { Request, Response } from "express";
import cors from 'cors';
import { globalErrorHandler } from "./common/middleware/globalErrorHandler";
import cookieParser from "cookie-parser";
import customerRouter from "./customer/customerRouter";
import couponRouter from "./coupon/couponRouter";

const app = express();

 // Use CORS middleware
 app.use(cors());

app.use(cookieParser());
app.use(express.json());
app.get("/", (req: Request, res: Response) => {
  res.json({ message: "Hello from order service service!" });
});

app.use("/customer", customerRouter);
app.use("/coupons", couponRouter);

app.use(globalErrorHandler);

export default app;