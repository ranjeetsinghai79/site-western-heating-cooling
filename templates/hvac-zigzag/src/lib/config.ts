import type { SiteConfig } from "@core/web/types"

export const config: SiteConfig = {
  business: {
    logoUrl: "/logo.png",
    name: "Western Heating & Cooling",
    tagline: "Optimize cooling for dry climates.",
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
    since: "2010",
    google_rating: "4.8",
    review_count: "59",
    emergency: true,
    theme: "clean",
    niche: "hvac",
  },

  services: [
    { 
      icon: "thermometer", 
      title: "AC & Heating Installation", 
      desc: "Precision installations designed for maximum energy efficiency.", 
      urgent: false 
    },
    { 
      icon: "shield-check", 
      title: "Seasonal Maintenance", 
      desc: "Comprehensive pre-season check-ups to ensure peak performance.", 
      urgent: false 
    },
    { 
      icon: "wrench", 
      title: "Repair & Diagnostics", 
      desc: "Expert troubleshooting to restore your comfort quickly.", 
      urgent: true 
    },
    { 
      icon: "zap", 
      title: "Blower Motor Upgrades", 
      desc: "Advanced retrofits featuring Western Cooling Control™ technology.", 
      urgent: false 
    },
    { 
      icon: "dollar-sign", 
      title: "PG&E Home Rebates", 
      desc: "Maximize savings through the Comfortable Home Rebates program.", 
      urgent: false 
    },
    { 
      icon: "home", 
      title: "Multifamily HVAC Upgrades", 
      desc: "Scale efficiency with the PG&E MFCO upgrade program.", 
      urgent: false 
    }
  ],

  testimonials: [
    { 
      name: "Sarah Jenkins", 
      location: "Pleasanton, CA", 
      stars: 5, 
      text: "Western Heating & Cooling completely transformed our home's comfort. Their blower motor upgrade not only made our AC run whisper-quiet but also slashed our summer energy bills by 30%. The technicians were incredibly professional and left the workspace spotless." 
    },
    { 
      name: "David Chen", 
      location: "Central Valley, CA", 
      stars: 5, 
      text: "When our AC died during a brutal heatwave, they responded immediately. The diagnostic was thorough, and they explained the PG&E rebate program perfectly, saving us thousands on a high-efficiency replacement. I wouldn't trust anyone else with my HVAC." 
    },
    { 
      name: "Marcus Thorne", 
      location: "Pleasanton, CA", 
      stars: 5, 
      text: "As a property manager, I rely on Western for all our multifamily HVAC upgrades. Their expertise with PG&E MFCO programs is unmatched. They consistently deliver on time, on budget, and with exceptional quality control across all our properties." 
    }
  ],

  trustBadges: [
    "CA License #999624", 
    "PG&E Contractor of the Year", 
    "UC Davis Cooling Innovations", 
    "Mon–Fri 8AM–5PM"
  ],

  stats: [
    { value: 4.8, label: "Google Rating", suffix: "★", decimals: 1 },
    { value: 9999, label: "Motor Upgrades", suffix: "+", decimals: 0 },
    { value: 10, label: "Years Excellence", suffix: "+", decimals: 0 }
  ],

  reasons: [
    { 
      icon: "award", 
      title: "Award-Winning Experts", 
      desc: "Recognized as PG&E ACQC Contractor of the Year for unparalleled installation quality." 
    },
    { 
      icon: "zap", 
      title: "Efficiency Innovators", 
      desc: "Utilizing UC Davis Western Cooling Efficiency Center inspired technology for maximum savings." 
    },
    { 
      icon: "dollar-sign", 
      title: "Rebate Specialists", 
      desc: "Expertly navigating PG&E rebate programs to maximize your return on investment." 
    },
    { 
      icon: "shield-check", 
      title: "Quality Installation", 
      desc: "Rigorous field quality control ensures your high-efficiency system operates flawlessly." 
    },
    { 
      icon: "clock", 
      title: "Prompt Diagnostics", 
      desc: "Rapid, precise troubleshooting to restore your climate control without unnecessary delays." 
    },
    { 
      icon: "thumbs-up", 
      title: "Proven Track Record", 
      desc: "Over 9,999 high-efficiency blower fan motor retrofits successfully performed across California." 
    }
  ],

  formServiceOptions: [
    "AC & Heating Installation",
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