import type { SiteConfig } from "@core/web/types"

export const config: SiteConfig = {
  business: {
    logoUrl: "/logo.png",
    location: { lat: 37.6932989, lng: -121.9044578 },
    name: "Western Heating & Cooling",
    tagline: "High-efficiency Western climate HVAC solutions.",
    phone: "(877) 987-4822",
    phoneHref: "tel:+18779874822",
    email: "contact@westerncooling.com",
    address: "4900 Hopyard Road, Suite 100, Pleasanton, CA 94588",
    city: "Pleasanton",
    serviceAreas: [
      "Pleasanton",
      "California's Central Valley",
      "Western United States"
    ],
    license: "999624",
    google_rating: "4.8",
    review_count: "59",
    emergency: false,
    theme: "clean",
    niche: "hvac",
  },

  services: [
    { 
      icon: "home", 
      title: "New AC & Heating Installs", 
      desc: "Precision installations designed for optimal energy efficiency in dry Western climates.", 
      urgent: false 
    },
    { 
      icon: "thermometer", 
      title: "Seasonal Maintenance", 
      desc: "Comprehensive pre-season check-ups to ensure peak performance year-round.", 
      urgent: false 
    },
    { 
      icon: "wrench", 
      title: "Repair & Diagnostics", 
      desc: "Expert troubleshooting and lasting repairs for all major HVAC brands.", 
      urgent: true 
    },
    { 
      icon: "zap", 
      title: "Blower Motor Upgrades", 
      desc: "High-efficiency Concept 3™ and Western Cooling Control™ retrofits.", 
      urgent: false 
    },
    { 
      icon: "dollar-sign", 
      title: "PG&E Home Rebates", 
      desc: "Maximize your savings with the Comfortable Home Rebates Program.", 
      urgent: false 
    },
    { 
      icon: "briefcase", 
      title: "Multifamily HVAC Upgrades", 
      desc: "Scalable energy-efficient solutions for multifamily property managers.", 
      urgent: false 
    }
  ],

  testimonials: [],

  stats: [
    { value: 4.8, label: "Google Rating", suffix: "★", decimals: 1 },
    { value: 9999, label: "Motor Retrofits", suffix: "+", decimals: 0 },
  ],

  reasons: [
    { 
      icon: "award", 
      title: "Award-Winning Expertise", 
      desc: "Recognized as PG&E ACQC Contractor of the Year for unmatched installation quality." 
    },
    { 
      icon: "zap", 
      title: "Efficiency Innovators", 
      desc: "Pioneering cooling solutions inspired by the UC Davis Western Cooling Efficiency Center." 
    },
    { 
      icon: "dollar-sign", 
      title: "Rebate Specialists", 
      desc: "We navigate PG&E rebate programs to maximize your investment in high-efficiency comfort." 
    },
    { 
      icon: "shield-check", 
      title: "Immaculate Installations", 
      desc: "Every system is installed with exacting precision to ensure flawless, long-lasting performance." 
    },
    { 
      icon: "clock", 
      title: "Prompt Professionalism", 
      desc: "Respecting your time with punctual arrivals and efficient, minimally invasive service." 
    },
    { 
      icon: "thumbs-up", 
      title: "Guaranteed Satisfaction", 
      desc: "Backed by rigorous quality control standards and a commitment to absolute client comfort." 
    }
  ],

  formServiceOptions: [
    "New AC & Heating Installs",
    "Seasonal Maintenance",
    "Repair & Diagnostics",
    "Blower Motor Upgrades",
    "PG&E Home Rebates",
    "Multifamily HVAC Upgrades"
  ]
}

export const BUSINESS = config.business
export const SERVICES = config.services!
export const TESTIMONIALS = config.testimonials!
export const TRUST_BADGES = config.trustBadges!