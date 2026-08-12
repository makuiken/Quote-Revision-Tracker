import { useState } from "react";
import { useLocation } from "wouter";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateQuote } from "@workspace/api-client-react";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toaster";
import { INTERIOR_DOOR_FIELDS, EXTERIOR_DOOR_FIELDS } from "@/lib/spec-fields";

const doorSpecSchema = z.object({
  brand: z.string().optional(),
  seriesStyle: z.string().optional(),
  materialSpecies: z.string().optional(),
  exteriorColor: z.string().optional(),
  interiorFinish: z.string().optional(),
  jambDepth: z.string().optional(),
  hardwareFinish: z.string().optional(),
  glassLiteOptions: z.string().optional(),
  lockPrep: z.string().optional(),
}).optional();

const quoteSchema = z.object({
  quoteNumber: z.string().regex(/^[0-9]{7}$/, "Must be exactly 7 digits"),
  customerName: z.string().min(1, "Customer name is required"),
  projectName: z.string().min(1, "Project name is required"),
  jobAddress: z.string().min(1, "Job address is required"),
  categories: z.array(z.enum(["interiorDoors", "exteriorDoors", "windows", "trim", "millwork"])).min(1, "Select at least one category"),
  notes: z.string().optional(),
  specs: z.object({
    window: z.object({
      brand: z.string().optional(),
      series: z.string().optional(),
      exteriorColor: z.string().optional(),
      interiorColor: z.string().optional(),
      jambDepth: z.string().optional(),
      dividedLites: z.string().optional(),
      hardwareFinish: z.string().optional(),
      screenColor: z.string().optional(),
    }).optional(),
    interiorDoor: doorSpecSchema,
    exteriorDoor: doorSpecSchema,
    trimDescription: z.string().optional(),
    millworkDescription: z.string().optional(),
  }).optional(),
});

type QuoteFormValues = z.infer<typeof quoteSchema>;

const CATEGORIES = [
  { id: "interiorDoors", label: "Interior Doors" },
  { id: "exteriorDoors", label: "Exterior Doors" },
  { id: "windows", label: "Windows" },
  { id: "trim", label: "Moulding" },
  { id: "millwork", label: "Misc. Millwork" },
] as const;

export default function NewQuotePage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createQuote = useCreateQuote();

  const form = useForm<QuoteFormValues>({
    resolver: zodResolver(quoteSchema),
    defaultValues: {
      quoteNumber: "",
      customerName: "",
      projectName: "",
      jobAddress: "",
      categories: [],
      notes: "",
      specs: {},
    },
  });

  const selectedCategories = form.watch("categories") || [];

  const onSubmit = (data: QuoteFormValues) => {
    createQuote.mutate({ data }, {
      onSuccess: (quote) => {
        toast({
          title: "Quote Created",
          description: `Quote ${quote.quoteNumber} created successfully.`,
        });
        setLocation(`/quotes/${quote.id}`);
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Failed to create quote. Please try again.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-3xl font-serif font-bold text-primary mb-2">New Quote</h1>
        <p className="text-muted-foreground font-medium">Create a new quote record to start tracking revisions.</p>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8 max-w-4xl">
        <Card>
          <CardContent className="p-6 sm:p-8 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="quoteNumber">BisTrack Quote #</Label>
                <p className="text-xs text-muted-foreground">7-digit number from BisTrack</p>
                <Input 
                  id="quoteNumber" 
                  placeholder="e.g. 1234567" 
                  inputMode="numeric"
                  maxLength={7}
                  {...form.register("quoteNumber")} 
                />
                {form.formState.errors.quoteNumber && (
                  <p className="text-sm text-destructive font-medium">{form.formState.errors.quoteNumber.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerName">Customer Name</Label>
                <div className="h-4"></div>
                <Input 
                  id="customerName" 
                  placeholder="e.g. John Doe / Acme Builders" 
                  {...form.register("customerName")} 
                />
                {form.formState.errors.customerName && (
                  <p className="text-sm text-destructive font-medium">{form.formState.errors.customerName.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="projectName">Project Name</Label>
                <Input 
                  id="projectName" 
                  placeholder="e.g. Main Street Renovation" 
                  {...form.register("projectName")} 
                />
                {form.formState.errors.projectName && (
                  <p className="text-sm text-destructive font-medium">{form.formState.errors.projectName.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="jobAddress">Job Address</Label>
                <Input 
                  id="jobAddress" 
                  placeholder="e.g. 123 Main St, City, ST 12345" 
                  {...form.register("jobAddress")} 
                />
                {form.formState.errors.jobAddress && (
                  <p className="text-sm text-destructive font-medium">{form.formState.errors.jobAddress.message}</p>
                )}
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t-2 border-border">
              <Label className="text-lg">Product Categories</Label>
              <p className="text-sm text-muted-foreground">Select all that apply for this quote.</p>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {CATEGORIES.map(category => (
                  <Controller
                    key={category.id}
                    name="categories"
                    control={form.control}
                    render={({ field }) => (
                      <label 
                        className={`flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                          field.value?.includes(category.id) ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-accent/50'
                        }`}
                      >
                        <Checkbox 
                          checked={field.value?.includes(category.id)}
                          onCheckedChange={(checked) => {
                            const current = field.value || [];
                            const next = checked 
                              ? [...current, category.id]
                              : current.filter(c => c !== category.id);
                            field.onChange(next);
                          }}
                        />
                        <span className="font-bold select-none">{category.label}</span>
                      </label>
                    )}
                  />
                ))}
              </div>
              {form.formState.errors.categories && (
                <p className="text-sm text-destructive font-medium">{form.formState.errors.categories.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {selectedCategories.includes("windows") && (
          <Card>
            <CardContent className="p-6 sm:p-8 space-y-6">
              <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Window Specifications</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {["brand", "series", "exteriorColor", "interiorColor", "jambDepth", "dividedLites", "hardwareFinish", "screenColor"].map((field) => (
                  <div key={field} className="space-y-2">
                    <Label htmlFor={`window.${field}`}>{field.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</Label>
                    <Input 
                      id={`window.${field}`} 
                      {...form.register(`specs.window.${field}` as any)} 
                    />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {([
          ["interiorDoors", "interiorDoor", "Interior Door Specifications", INTERIOR_DOOR_FIELDS],
          ["exteriorDoors", "exteriorDoor", "Exterior Door Specifications", EXTERIOR_DOOR_FIELDS],
        ] as const).map(([category, specKey, title, fields]) =>
          selectedCategories.includes(category) && (
            <Card key={category}>
              <CardContent className="p-6 sm:p-8 space-y-6">
                <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">{title}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {fields.map((field) => (
                    <div key={field.key} className="space-y-2">
                      <Label htmlFor={`${specKey}.${field.key}`}>{field.label}</Label>
                      <Input 
                        id={`${specKey}.${field.key}`} 
                        {...form.register(`specs.${specKey}.${field.key}` as any)} 
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )
        )}

        {selectedCategories.includes("trim") && (
          <Card>
            <CardContent className="p-6 sm:p-8 space-y-4">
              <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Moulding Specifications</h3>
              <div className="space-y-2">
                <Label htmlFor="trimDescription">Description / Details</Label>
                <Textarea 
                  id="trimDescription" 
                  {...form.register("specs.trimDescription")} 
                  placeholder="Enter moulding profiles, materials, lengths..."
                  className="h-32"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {selectedCategories.includes("millwork") && (
          <Card>
            <CardContent className="p-6 sm:p-8 space-y-4">
              <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">Millwork Specifications</h3>
              <div className="space-y-2">
                <Label htmlFor="millworkDescription">Description / Details</Label>
                <Textarea 
                  id="millworkDescription" 
                  {...form.register("specs.millworkDescription")} 
                  placeholder="Enter custom millwork details, cabinetry..."
                  className="h-32"
                />
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-6 sm:p-8 space-y-4">
            <h3 className="text-xl font-serif font-bold text-foreground border-b-2 border-border pb-2">General Notes</h3>
            <div className="space-y-2">
              <Textarea 
                {...form.register("notes")} 
                placeholder="Any overarching notes or delivery instructions..."
                className="h-32"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-4 pt-4">
          <Button type="button" variant="outline" size="lg" onClick={() => setLocation("/quotes")}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={createQuote.isPending} className="px-10">
            {createQuote.isPending ? "Saving..." : "Create Quote"}
          </Button>
        </div>
      </form>
    </Shell>
  );
}