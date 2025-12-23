const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

let shiprocketToken = null;
let tokenExpiry = null;
console.log("Email is : ", process.env.SHIPROCKET_EMAIL);
console.log("Pwd is : ", process.env.SHIPROCKET_PASSWORD);

// =======================
// Shiprocket Login
// =======================
async function getShiprocketToken() {
  if (shiprocketToken && tokenExpiry > Date.now()) {
    return shiprocketToken;
  }

  const res = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    {
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD
    }
  );

  console.log("Shiprocket login success", res.data);

  shiprocketToken = res.data.token;
  tokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000; // ~9 days

  return shiprocketToken;
}

// =======================
// Delivery Check API
// =======================
app.post("/test/check-delivery", async (req, res) => {
  try {
    console.log("Received request", req.body);
    const { pincode } = req.body;

    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({ success: false });
    }

    const token = await getShiprocketToken();
    console.log("Shiprocket token : ", token);
    
    const response = await axios.get(
      "https://apiv2.shiprocket.in/v1/external/courier/serviceability/",
      {
        headers: {
            'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        params: {
          pickup_postcode: "110077", // IMPORTANT
          delivery_postcode: pincode,
          weight: 0.5,
          cod: 0
        },
        timeout: 8000
      }
    );
    console.log("Shiprocket serviceability response", response.data);
    const courier =
      response.data?.data?.available_courier_companies?.[0];

    if (!courier) {
      return res.json({ success: false });
    }

    res.json({
      success: true,
      etd: courier.etd ||
        `Delivered in ${courier.estimated_delivery_days} days`
    });

  } catch (error) {
    console.error(
      "Shiprocket error:",
      error.response?.data || error.message
    );

    res.status(500).json({ success: false });
  }
});

app.listen(3000, () => {
  console.log("Backend running on port 3000");
});
