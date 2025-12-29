const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

let shiprocketToken = null;
let tokenExpiry = null;

// =======================
// Shiprocket Login
// =======================
async function getShiprocketToken() {
  if (shiprocketToken && tokenExpiry > Date.now()) {
    return shiprocketToken;
  }

  try {
    const res = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/auth/login",
      {
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      }
    );

    shiprocketToken = res.data.token;
    tokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000; // ~9 days

    console.log("✅ Shiprocket login successful");
    return shiprocketToken;
  } catch (error) {
    console.error(
      "❌ Shiprocket login failed:",
      error.response?.data || error.message
    );
    throw new Error("Failed to authenticate with Shiprocket");
  }
}

// Hyperlocal delivery pincodes (within 50km radius)
const HYPERLOCAL_PINCODES = [
  "110001",
  "110002",
  "110003",
  "110004",
  "110005",
  "110006",
  "110007",
  "110008",
  "110009",
  "110010",
  "110011",
  "110012",
  "110013",
  "110014",
  "110015",
  "110077",
  "110078",
  "110071",
  "110070",
];

// Pincode to coordinates mapping for Delhi
const PINCODE_COORDINATES = {
  110001: { lat: "28.6139", lng: "77.2090" }, // Connaught Place
  110002: { lat: "28.6328", lng: "77.2197" }, // Darya Ganj
  110003: { lat: "28.7041", lng: "77.1025" }, // Civil Lines
  110004: { lat: "28.6517", lng: "77.2219" }, // Rashtrapati Bhavan
  110005: { lat: "28.6436", lng: "77.2186" }, // Karol Bagh
  110006: { lat: "28.6304", lng: "77.2177" }, // Rajinder Nagar
  110007: { lat: "28.6455", lng: "77.2167" }, // Motia Khan
  110008: { lat: "28.6341", lng: "77.2419" }, // Daryaganj
  110009: { lat: "28.6219", lng: "77.2324" }, // Paharganj
  110010: { lat: "28.6341", lng: "77.2419" }, // Jhandewalan
  110011: { lat: "28.6219", lng: "77.2324" }, // NDSE Part 1
  110012: { lat: "28.5729", lng: "77.2545" }, // Lajpat Nagar
  110013: { lat: "28.6341", lng: "77.2419" }, // Jama Masjid
  110014: { lat: "28.5985", lng: "77.2386" }, // Nizamuddin
  110015: { lat: "28.5355", lng: "77.2499" }, // Kalkaji
  110077: { lat: "28.4595", lng: "77.0266" }, // Saket
  110078: { lat: "28.5355", lng: "77.2499" }, // Nehru Place
  110071: { lat: "28.5355", lng: "77.2499" }, // Panchsheel Park
  110070: { lat: "28.5355", lng: "77.2499" }, // Sheikh Sarai
};

// Your warehouse/pickup location coordinates
const PICKUP_LOCATION = {
  pincode: "110077",
  lat: "28.4595", // Update with your actual warehouse coordinates
  lng: "77.0266",
};

// =======================
// Get coordinates for pincode
// =======================
function getCoordinatesForPincode(pincode) {
  // Return known coordinates or default Delhi center
  return (
    PINCODE_COORDINATES[pincode] || {
      lat: "28.6139",
      lng: "77.2090",
    }
  );
}

// =======================
// Check Hyperlocal Serviceability (FIXED)
// =======================
async function checkHyperlocalServiceability(
  pincode,
  token,
  deliveryLat,
  deliveryLng
) {
  try {
    // If coordinates not provided, get from pincode mapping
    const deliveryCoords =
      deliveryLat && deliveryLng
        ? { lat: deliveryLat, lng: deliveryLng }
        : getCoordinatesForPincode(pincode);

    console.log(`🔍 Checking serviceability for pincode: ${pincode}`);
    console.log(`📍 Pickup: ${PICKUP_LOCATION.lat}, ${PICKUP_LOCATION.lng}`);
    console.log(`📍 Delivery: ${deliveryCoords.lat}, ${deliveryCoords.lng}`);

    const response = await axios.get(
      "https://apiv2.shiprocket.in/v1/external/courier/serviceability/",
      {
        params: {
          pickup_postcode: PICKUP_LOCATION.pincode,
          delivery_postcode: pincode,
          weight: 0.5, // REQUIRED - weight in kg
          cod: 0, // REQUIRED - 0 for prepaid, 1 for COD
          is_new_hyperlocal: 1, // Enable hyperlocal

          // Pickup location (your warehouse)
          lat_from: PICKUP_LOCATION.lat,
          long_from: PICKUP_LOCATION.lng,

          // Delivery location (customer)
          lat_to: deliveryCoords.lat,
          long_to: deliveryCoords.lng,
        },
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ Serviceability check successful for ${pincode}`);
    return response.data;
  } catch (error) {
    console.error(
      "❌ Serviceability check error:",
      error.response?.data || error.message
    );
    return null;
  }
}

// =======================
// Delivery Check API (UPDATED)
// =======================
app.post("/check-delivery", async (req, res) => {
  try {
    const { pincode, lat, lng, weight, cod } = req.body;

    // Validate pincode format
    if (!pincode || !/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pincode format. Please enter a 6-digit pincode.",
      });
    }

    // Check if pincode is in hyperlocal list
    if (!HYPERLOCAL_PINCODES.includes(pincode)) {
      return res.json({
        success: false,
        message:
          "We don't deliver here. To place order, message us on 1234567890",
      });
    }

    // Get Shiprocket token
    const token = await getShiprocketToken();

    // Check serviceability with coordinates
    const serviceabilityData = await checkHyperlocalServiceability(
      pincode,
      token,
      lat,
      lng
    );

    if (
      !serviceabilityData ||
      serviceabilityData.status !== 200 ||
      !serviceabilityData.data ||
      !serviceabilityData.data.available_courier_companies
    ) {
      return res.json({
        success: false,
        message: "Delivery not available for this pincode",
        debug_info: serviceabilityData,
      });
    }

    const couriers = serviceabilityData.data.available_courier_companies;

    if (couriers.length === 0) {
      return res.json({
        success: false,
        message: "No courier available for delivery to this pincode",
      });
    }

    console.log(`📦 Found ${couriers.length} available couriers`);

    // Filter for hyperlocal/quick delivery couriers
    const quickCouriers = couriers.filter((courier) => {
      const name = courier.courier_name?.toLowerCase() || "";
      const etdHours = courier.etd_hours || 999;

      // Known hyperlocal providers
      const isHyperlocalProvider =
        name.includes("shadowfax") ||
        name.includes("dunzo") ||
        name.includes("borzo") ||
        name.includes("ola") ||
        name.includes("flash") ||
        name.includes("loadshare") ||
        name.includes("rapido") ||
        name.includes("wefast") ||
        name.includes("porter") ||
        name.includes("delhivery") ||
        name.includes("ecom");

      // Quick delivery means ETD within 12 hours
      const isQuickDelivery = etdHours <= 12;

      return isHyperlocalProvider || isQuickDelivery;
    });

    console.log(`⚡ Found ${quickCouriers.length} hyperlocal/quick couriers`);

    // Use quick courier if available, otherwise use best available
    const selectedCourier =
      quickCouriers.length > 0 ? quickCouriers[0] : couriers[0];
    const etdHours = selectedCourier.etd_hours || 48;

    console.log(
      `✅ Selected courier: ${selectedCourier.courier_name} (ETD: ${etdHours}h)`
    );

    // Determine delivery time based on ETD hours
    let deliveryTime, etdText, serviceType, isHyperlocal;

    if (etdHours <= 4) {
      deliveryTime = "2-4 hours";
      etdText = "Same Day (2-4 hours)";
      serviceType = "quick";
      isHyperlocal = true;
    } else if (etdHours <= 8) {
      deliveryTime = "4-8 hours";
      etdText = "Same Day (4-8 hours)";
      serviceType = "quick";
      isHyperlocal = true;
    } else if (etdHours <= 12) {
      deliveryTime = "Same Day";
      etdText = "Same Day Delivery";
      serviceType = "express";
      isHyperlocal = true;
    } else if (etdHours <= 24) {
      deliveryTime = "Next Day";
      etdText = "Next Day Delivery";
      serviceType = "fast";
      isHyperlocal = false;
    } else {
      const days = Math.ceil(etdHours / 24);
      deliveryTime = `${days} days`;
      etdText = selectedCourier.etd || `Delivery in ${days} days`;
      serviceType = "standard";
      isHyperlocal = false;
    }

    return res.json({
      success: true,
      delivery_time: deliveryTime,
      delivery_charge:
        selectedCourier.freight_charge || selectedCourier.rate || 49,
      courier_name: selectedCourier.courier_name,
      courier_id: selectedCourier.courier_company_id,
      etd: etdText,
      is_hyperlocal: isHyperlocal,
      service_type: serviceType,
      etd_hours: etdHours,
      total_couriers_available: couriers.length,
      hyperlocal_couriers_available: quickCouriers.length,
    });
  } catch (error) {
    console.error(
      "❌ Delivery check error:",
      error.response?.data || error.message
    );

    if (error.response?.status === 401) {
      shiprocketToken = null;
      tokenExpiry = null;
      return res.status(401).json({
        success: false,
        message: "Authentication failed. Please try again.",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to check delivery availability. Please try again later.",
      error: error.message,
    });
  }
});

// =======================
// Create Quick/Hyperlocal Order
// =======================
app.post("/create-quick-order", async (req, res) => {
  try {
    const { orderData } = req.body;
    const token = await getShiprocketToken();

    // Validate required fields
    if (!orderData.courier_id) {
      return res.status(400).json({
        success: false,
        message: "courier_id is required. Please check serviceability first.",
      });
    }

    console.log(
      `📦 Creating quick order for courier_id: ${orderData.courier_id}`
    );

    // Use Quick Create Order API for hyperlocal deliveries
    const response = await axios.post(
      "https://apiv2.shiprocket.in/v1/external/orders/create/quick-ship",
      {
        order_id: orderData.order_id,
        order_date:
          orderData.order_date || new Date().toISOString().split("T")[0],
        pickup_location: orderData.pickup_location || "Primary",
        channel_id: orderData.channel_id || "",
        comment: orderData.comment || "Hyperlocal Quick Delivery",
        billing_customer_name: orderData.customer_name,
        billing_last_name: orderData.last_name || "",
        billing_address: orderData.billing_address,
        billing_address_2: orderData.billing_address_2 || "",
        billing_city: orderData.billing_city,
        billing_pincode: orderData.billing_pincode,
        billing_state: orderData.billing_state,
        billing_country: orderData.billing_country || "India",
        billing_email: orderData.billing_email,
        billing_phone: orderData.billing_phone,
        shipping_is_billing: orderData.shipping_is_billing !== false,
        shipping_customer_name:
          orderData.shipping_customer_name || orderData.customer_name,
        shipping_last_name:
          orderData.shipping_last_name || orderData.last_name || "",
        shipping_address:
          orderData.shipping_address || orderData.billing_address,
        shipping_address_2:
          orderData.shipping_address_2 || orderData.billing_address_2 || "",
        shipping_city: orderData.shipping_city || orderData.billing_city,
        shipping_pincode:
          orderData.shipping_pincode || orderData.billing_pincode,
        shipping_country:
          orderData.shipping_country || orderData.billing_country || "India",
        shipping_state: orderData.shipping_state || orderData.billing_state,
        shipping_email: orderData.shipping_email || orderData.billing_email,
        shipping_phone: orderData.shipping_phone || orderData.billing_phone,
        order_items: orderData.order_items,
        payment_method: orderData.payment_method || "Prepaid",
        shipping_charges: orderData.shipping_charges || 0,
        giftwrap_charges: orderData.giftwrap_charges || 0,
        transaction_charges: orderData.transaction_charges || 0,
        total_discount: orderData.total_discount || 0,
        sub_total: orderData.sub_total,
        length: orderData.length || 10,
        breadth: orderData.breadth || 10,
        height: orderData.height || 10,
        weight: orderData.weight || 0.5,
        courier_id: orderData.courier_id, // From serviceability check
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Quick order created successfully");

    res.json({
      success: true,
      order_id: response.data.order_id,
      shipment_id: response.data.shipment_id,
      awb_code: response.data.awb_code,
      courier_name: response.data.courier_name,
      data: response.data,
    });
  } catch (error) {
    console.error(
      "❌ Quick order creation failed:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      message: "Failed to create quick order",
      error: error.response?.data || error.message,
    });
  }
});

// =======================
// Track Order
// =======================
app.get("/track-order/:shipment_id", async (req, res) => {
  try {
    const { shipment_id } = req.params;
    const token = await getShiprocketToken();

    const response = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/shipment/${shipment_id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({
      success: true,
      tracking_data: response.data,
    });
  } catch (error) {
    console.error("❌ Tracking error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      message: "Failed to track order",
      error: error.response?.data || error.message,
    });
  }
});

// =======================
// Get Pincode Coordinates (Helper endpoint)
// =======================
app.get("/get-coordinates/:pincode", (req, res) => {
  const { pincode } = req.params;
  const coords = getCoordinatesForPincode(pincode);

  res.json({
    success: true,
    pincode,
    coordinates: coords,
    is_mapped: !!PINCODE_COORDINATES[pincode],
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    pickup_location: PICKUP_LOCATION,
    hyperlocal_pincodes: HYPERLOCAL_PINCODES.length,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`📦 Shiprocket Hyperlocal delivery integration active`);
  console.log(
    `📍 Pickup location: ${PICKUP_LOCATION.pincode} (${PICKUP_LOCATION.lat}, ${PICKUP_LOCATION.lng})`
  );
  console.log(`🏙️  Serving ${HYPERLOCAL_PINCODES.length} hyperlocal pincodes`);
});
