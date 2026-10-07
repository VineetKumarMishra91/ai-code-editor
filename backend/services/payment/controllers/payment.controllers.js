import razorpay from "../config/razorpay.js"
import Payment from "../models/payment.model.js"
import crypto from "crypto"
import { addCredits } from "../utils/updateCredits.js"
const Plans = {
    pro: {
        name: "Pro",
        amount: 29900,
        credits: 500,
    },

    team: {
        name: "Team",
        amount: 79900,
        credits: 2000,
    },
}


export const createOrder = async (req, res) => {
    try {
        const userId = req.headers["x-user-id"]
        if (!userId) {
            return res.status(400).json({ "message": "userid is not found" })
        }
        const { plan } = req.body
        const selectedPlan = Plans[plan]
        if (!selectedPlan) {
            return res.status(400).json({ "message": "plan is not found" })
        }

        const order = await razorpay.orders.create({
            amount: selectedPlan.amount,
            currency: "INR",
            receipt: `receipt-${Date.now()}`,
            notes: { userId, plan }
        })

        const payment = await Payment.create({
            userId,
            plan,
            credits:selectedPlan.credits,
            amount: selectedPlan.amount,
            razorpayOrderId: order.id,
            currency: "INR",
            status: "created"
        })

        return res.status(201).json({
            order: {
                id: order.id,
                amount: order.amount,
                currency: order.currency
            },
            plan: {
                name: selectedPlan.name,
                credits: selectedPlan.credits
            },
            key_id: process.env.RAZORPAY_KEY_ID
        })

    } catch (error) {
        return res.status(500).json({ message: `create order error ${error}` })
    }
}

export const verify = async (req, res) => {
    try {
        const userId = req.headers["x-user-id"]
        if (!userId) {
            return res.status(400).json({ "message": "userid is not found" })
        }
        const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body
        if(!razorpay_order_id || !razorpay_payment_id || !razorpay_signature){
             return res.status(400).json({ message:"razorpay_order_id,razorpay_payment_id,razorpay_signature not found" })
        }

        const payment=await Payment.findOne({
            razorpayOrderId:razorpay_order_id
        })

        if(!payment){
            return res.status(400).json({ "message": "payment is not found" })
        }

        if(String(payment.userId)!==String(userId)){
            return res.status(403).json({ "message": "payment does not belong to this user" })
        }

        if(payment.status=="paid"){
            return res.status(400).json({ "message": "payment is already Verified" })
        }

        const generatedSignature=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex")
        if( generatedSignature !==  razorpay_signature
){
            payment.status="failed"
            await payment.save()
            return res.status(400).json({ "message": "invaild payment signature" })
        }

        // Atomically claim the payment so concurrent verify calls can't double-credit
        const claimed=await Payment.findOneAndUpdate(
            {_id:payment._id,status:{$ne:"paid"}},
            {status:"paid",razorpayPaymentId:razorpay_payment_id}
        )
        if(!claimed){
            return res.status(400).json({ "message": "payment is already Verified" })
        }

        const data=await addCredits({userId,credits:payment.credits})
        if(data===null){
            // Credits were not granted: release the claim so verify can be retried
            await Payment.updateOne(
                {_id:payment._id},
                {status:"created",razorpayPaymentId:null}
            )
            return res.status(502).json({ "message": "could not add credits, please retry verification" })
        }

       return res.status(200).json({
           message:"payment verified"
        })
          

    } catch (error) {
     return res.status(500).json({ message: `verify payment error ${error}` })
    }
}

