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

// Optional: Hyperlocal delivery pincodes whitelist (leave empty to check all pincodes dynamically)
// If you want to restrict delivery to specific pincodes, add them here
// Leave empty array [] to allow Shiprocket API to determine serviceability for any pincode
const HYPERLOCAL_PINCODES = process.env.HYPERLOCAL_PINCODES 
  ? process.env.HYPERLOCAL_PINCODES.split(',').map(p => p.trim())
  : []; // Empty by default - fully dynamic
console.log("HYPERLOCAL_PINCODES", HYPERLOCAL_PINCODES);
// Your warehouse/pickup location coordinates
const PICKUP_LOCATION = {
  pincode: "110077",
  lat: "28.4595", // Update with your actual warehouse coordinates
  lng: "77.0266",
};

// Cache for pincode coordinates to avoid repeated API calls
const pincodeCache = {};

// =======================
// Get coordinates for pincode using geocoding API
// =======================
async function getCoordinatesForPincode(pincode) {
  // Check cache first
  if (pincodeCache[pincode]) {
    console.log(`📦 Using cached coordinates for pincode: ${pincode}`);
    return pincodeCache[pincode];
  }

  // Use geocoding API to get coordinates dynamically
  try {
    console.log(`🔍 Fetching coordinates for pincode: ${pincode} from geocoding API`);
    
    // Using Nominatim (OpenStreetMap) - free geocoding service
    // Format: pincode, India
    const response = await axios.get(
      "https://nominatim.openstreetmap.org/search",
      {
        params: {
          q: `${pincode}, India`,
          format: "json",
          limit: 1,
          addressdetails: 1,
        },
        headers: {
          "User-Agent": "Shiprocket-Backend/1.0", // Required by Nominatim
        },
        timeout: 5000, // 5 second timeout
      }
    );

    if (response.data && response.data.length > 0) {
      const result = response.data[0];
      const coordinates = {
        lat: parseFloat(result.lat).toFixed(6),
        lng: parseFloat(result.lon).toFixed(6),
      };

      // Cache the result
      pincodeCache[pincode] = coordinates;
      console.log(`✅ Found coordinates for ${pincode}: ${coordinates.lat}, ${coordinates.lng}`);
      return coordinates;
    }

    // Fallback: Try alternative geocoding API (India Post API or similar)
    console.log(`⚠️ Nominatim didn't find results, trying alternative API...`);
    return await getCoordinatesFromAlternativeAPI(pincode);
  } catch (error) {
    console.error(`❌ Geocoding error for pincode ${pincode}:`, error.message);
    
    // Fallback to alternative API
    try {
      return await getCoordinatesFromAlternativeAPI(pincode);
    } catch (fallbackError) {
      console.error(`❌ All geocoding APIs failed for pincode ${pincode}`);
      // Last resort: return default Delhi center coordinates
      const defaultCoords = {
        lat: "28.6139",
        lng: "77.2090",
      };
      pincodeCache[pincode] = defaultCoords;
      return defaultCoords;
    }
  }
}

// Alternative geocoding API fallback
async function getCoordinatesFromAlternativeAPI(pincode) {
  try {
    // Using Postalpincode.in API (free, India-specific)
    const response = await axios.get(
      `https://api.postalpincode.in/pincode/${pincode}`,
      {
        timeout: 5000,
      }
    );

    if (
      response.data &&
      response.data[0] &&
      response.data[0].PostOffice &&
      response.data[0].PostOffice.length > 0
    ) {
      const postOffice = response.data[0].PostOffice[0];
      const state = postOffice.State;
      const district = postOffice.District;

      // Use Nominatim again with more specific location
      const detailedResponse = await axios.get(
        "https://nominatim.openstreetmap.org/search",
        {
          params: {
            q: `${pincode}, ${district}, ${state}, India`,
            format: "json",
            limit: 1,
          },
          headers: {
            "User-Agent": "Shiprocket-Backend/1.0",
          },
          timeout: 5000,
        }
      );

      if (detailedResponse.data && detailedResponse.data.length > 0) {
        const result = detailedResponse.data[0];
        const coordinates = {
          lat: parseFloat(result.lat).toFixed(6),
          lng: parseFloat(result.lon).toFixed(6),
        };
        pincodeCache[pincode] = coordinates;
        console.log(`✅ Found coordinates via alternative API: ${coordinates.lat}, ${coordinates.lng}`);
        return coordinates;
      }
    }
  } catch (error) {
    console.error(`❌ Alternative API error:`, error.message);
    throw error;
  }

  throw new Error("No coordinates found");
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
    // If coordinates not provided, get from pincode geocoding
    let deliveryCoords;
    if (deliveryLat && deliveryLng) {
      deliveryCoords = { lat: deliveryLat, lng: deliveryLng };
    } else {
      deliveryCoords = await getCoordinatesForPincode(pincode);
    }

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

    // Optional: Check if pincode is in whitelist (only if HYPERLOCAL_PINCODES is configured)
    // If HYPERLOCAL_PINCODES is empty, skip this check and let Shiprocket API determine serviceability
    if (HYPERLOCAL_PINCODES.length > 0 && !HYPERLOCAL_PINCODES.includes(pincode)) {
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

    // Handle different response formats from Shiprocket API
    let couriers = [];
    
    if (!serviceabilityData) {
      return res.json({
        success: false,
        message: "Delivery not available for this pincode",
        debug_info: serviceabilityData,
      });
    }

    // Check for Shiprocket Quick API format (status: true, data: array)
    if (serviceabilityData.status === true && Array.isArray(serviceabilityData.data)) {
      couriers = serviceabilityData.data.map(courier => ({
        courier_name: courier.courier_name,
        courier_company_id: courier.courier_company_id || courier.courier_id,
        freight_charge: courier.rates || courier.freight_charge || courier.rate,
        rate: courier.rates || courier.rate,
        etd: courier.etd,
        etd_hours: courier.etd_hours,
        distance: courier.distance,
        rto_rates: courier.rto_rates,
      }));
    }
    // Check for standard Shiprocket API format (status: 200, data.available_courier_companies)
    else if (
      serviceabilityData.status === 200 &&
      serviceabilityData.data &&
      Array.isArray(serviceabilityData.data.available_courier_companies)
    ) {
      couriers = serviceabilityData.data.available_courier_companies;
    }
    // Fallback: try to extract couriers from data if it's an array
    else if (Array.isArray(serviceabilityData.data)) {
      couriers = serviceabilityData.data;
    }
    // Fallback: check if couriers are directly in the response
    else if (Array.isArray(serviceabilityData.available_courier_companies)) {
      couriers = serviceabilityData.available_courier_companies;
    }

    // If no couriers found, return error
    if (!couriers || couriers.length === 0) {
      return res.json({
        success: false,
        message: "Delivery not available for this pincode",
        debug_info: {
          message: "No couriers found in response",
          response_structure: serviceabilityData,
        },
      });
    }

    console.log(`📦 Found ${couriers.length} available couriers`);
    console.log(`📋 Couriers:`, JSON.stringify(couriers, null, 2));

    // Filter for hyperlocal/quick delivery couriers
    const quickCouriers = couriers.filter((courier) => {
      const name = courier.courier_name?.toLowerCase() || "";
      const etdHours = courier.etd_hours || 999;

      // Known hyperlocal providers (including Shiprocket Quick)
      const isHyperlocalProvider =
        name.includes("quick") ||
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
        selectedCourier.freight_charge || 
        selectedCourier.rate || 
        selectedCourier.rates || 
        49,
      courier_name: selectedCourier.courier_name,
      courier_id: selectedCourier.courier_company_id || selectedCourier.courier_id,
      etd: etdText,
      is_hyperlocal: isHyperlocal,
      service_type: serviceType,
      etd_hours: etdHours,
      total_couriers_available: couriers.length,
      hyperlocal_couriers_available: quickCouriers.length,
      distance: selectedCourier.distance,
      rto_rates: selectedCourier.rto_rates,
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
// Get All Delivery Addresses and Courier Options (Hyperlocal)
// =======================
app.get("/get-delivery-addresses", async (req, res) => {
  try {
    const { page = 1, per_page = 30 } = req.query;
    
    // Get Shiprocket token
    const token = await getShiprocketToken();

    console.log(`🔍 Fetching delivery addresses (page: ${page}, per_page: ${per_page})`);

    // Call Shiprocket hyperlocal delivery address API
    // Note: This endpoint uses .co domain (not .in)
    const response = await axios.get(
      "https://apiv2.shiprocket.co/v1/hyperlocal/deliveryaddress/getalldeliveryaddress",
      {
        params: {
          page: parseInt(page),
          per_page: parseInt(per_page),
          is_web: 1,
          is_hyperlocal: 1,
        },
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ Successfully fetched delivery addresses`);

    res.json({
      success: true,
      data: response.data,
      delivery_addresses: response.data?.data || response.data,
      pagination: {
        page: parseInt(page),
        per_page: parseInt(per_page),
      },
    });
  } catch (error) {
    console.error(
      "❌ Error fetching delivery addresses:",
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
      message: "Failed to fetch delivery addresses",
      error: error.response?.data || error.message,
    });
  }
});

// =======================
// Get Pincode Coordinates (Helper endpoint)
// =======================
app.get("/get-coordinates/:pincode", async (req, res) => {
  try {
    const { pincode } = req.params;
    
    // Validate pincode format
    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid pincode format. Please enter a 6-digit pincode.",
      });
    }

    const coords = await getCoordinatesForPincode(pincode);

    res.json({
      success: true,
      pincode,
      coordinates: coords,
      is_cached: !!pincodeCache[pincode],
      source: pincodeCache[pincode] ? "cache" : "geocoding_api",
    });
  } catch (error) {
    console.error(`❌ Error getting coordinates for ${req.params.pincode}:`, error.message);
    res.status(500).json({
      success: false,
      message: "Failed to get coordinates for pincode",
      error: error.message,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    pickup_location: PICKUP_LOCATION,
    hyperlocal_pincodes_whitelist_enabled: HYPERLOCAL_PINCODES.length > 0,
    hyperlocal_pincodes_count: HYPERLOCAL_PINCODES.length,
    coordinates_source: "dynamic_geocoding_api",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  console.log(`📦 Shiprocket Hyperlocal delivery integration active`);
  console.log(
    `📍 Pickup location: ${PICKUP_LOCATION.pincode} (${PICKUP_LOCATION.lat}, ${PICKUP_LOCATION.lng})`
  );
  if (HYPERLOCAL_PINCODES.length > 0) {
    console.log(`🏙️  Pincode whitelist enabled: ${HYPERLOCAL_PINCODES.length} pincodes`);
  } else {
    console.log(`🌍 Fully dynamic mode: All pincodes checked via Shiprocket API`);
  }
  console.log(`📍 Coordinates: Dynamic geocoding (no hardcoded mappings)`);
});
