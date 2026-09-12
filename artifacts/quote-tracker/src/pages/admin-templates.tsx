import { useState } from "react";
import { Link } from "wouter";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/components/ui/toaster";
import { Trash2, AlertTriangle, FileText, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { categoryLabel } from "@/lib/revision-categories";
import { Checkbox } from "@/components/ui/checkbox";
import { useQueryClient } from "@tanstack/react-query";
import { Redirect } from "wouter";
import {
  useListManufacturerRedactionTemplates,
  getListManufacturerRedactionTemplatesQueryKey,
  useUpdateManufacturerRedactionTemplate,
  useDeleteManufacturerRedactionTemplate,
  useGetCurrentUser,
  type ManufacturerRedactionTemplate
} from "@workspace/api-client-react";

import { QuoteCategoriesItem } from "@workspace/api-client-react";

export default function AdminTemplatesPage() {
  const queryClient = useQueryClient();
  const { data: dbUser, isLoading: isUserLoading } = useGetCurrentUser();
  const { data: templates = [], isLoading: isTemplatesLoading } = useListManufacturerRedactionTemplates({
    query: {
      enabled: dbUser?.role === 'admin',
      queryKey: getListManufacturerRedactionTemplatesQueryKey(),
    }
  });
  const updateTemplate = useUpdateManufacturerRedactionTemplate();
  const deleteTemplate = useDeleteManufacturerRedactionTemplate();
  const { toast } = useToast();

  const [deletingId, setDeletingId] = useState<number | null>(null);

  const handleDelete = (id: number) => {
    deleteTemplate.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Template deleted" });
        setDeletingId(null);
        queryClient.invalidateQueries({ queryKey: getListManufacturerRedactionTemplatesQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Failed to delete template", description: err.message, variant: "destructive" });
        setDeletingId(null);
      }
    });
  };

  if (!isUserLoading && dbUser?.role !== 'admin') {
    return <Redirect to="/quotes" />;
  }

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Manufacturer Packet Templates</h1>
        <p className="text-muted-foreground font-medium mt-1">
          Manage auto-applied redaction templates for manufacturer quotes.
        </p>
      </div>

      <div className="space-y-4">
        {isTemplatesLoading || isUserLoading ? (
          <div className="p-8 text-center text-muted-foreground font-medium">Loading templates...</div>
        ) : templates.length === 0 ? (
          <Card className="border-dashed bg-muted/50">
            <CardContent className="flex flex-col items-center justify-center p-12 text-center">
              <FileText className="w-12 h-12 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-bold text-foreground">No templates yet</h3>
              <p className="text-muted-foreground text-sm max-w-sm mt-2">
                Templates are created by saving a drawn packet as a default from the manufacturer quote editor.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {templates.map(template => (
              <Card key={template.id} className={`border-2 ${template.active ? 'border-primary/20' : 'border-border'} flex flex-col`}>
                <CardHeader className="pb-3 border-b border-border bg-muted/30">
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-lg font-bold">{template.name}</CardTitle>
                      <CardDescription className="font-medium text-xs mt-1">
                        {template.manufacturer} • {categoryLabel(template.productType as QuoteCategoriesItem)}
                      </CardDescription>
                    </div>
                    {template.active ? (
                      <span className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-green-700 bg-green-100 px-2 py-0.5 rounded border border-green-200">
                        <CheckCircle2 className="w-3 h-3" /> Active
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-muted-foreground bg-muted px-2 py-0.5 rounded border border-border">
                        Inactive
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex-1 p-4 flex flex-col justify-between gap-4">
                  <div className="space-y-2">
                    <div className="text-sm">
                      <span className="font-bold text-muted-foreground">Pages defined:</span>{" "}
                      <span className="font-medium">{template.pages.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-3 mt-1">
                      {template.pages.slice(0, 4).map((pageData) => (
                        <div key={pageData.pageNumber} className="flex flex-col items-center gap-1">
                          <div className="w-12 h-16 bg-muted/50 border border-border shadow-sm relative overflow-hidden rounded">
                            {/* Simple visual representation of redaction boxes assuming standard 612x792 page */}
                            {pageData.rects.map((rect, i: number) => (
                              <div 
                                key={i}
                                className="absolute bg-foreground/30 border border-foreground/50 rounded-[1px]"
                                style={{
                                  left: `${Math.min(100, Math.max(0, (rect.x / (pageData.width || 612)) * 100))}%`,
                                  top: `${Math.min(100, Math.max(0, (rect.y / (pageData.height || 792)) * 100))}%`,
                                  width: `${Math.min(100, Math.max(2, (rect.width / (pageData.width || 612)) * 100))}%`,
                                  height: `${Math.min(100, Math.max(2, (rect.height / (pageData.height || 792)) * 100))}%`
                                }}
                              />
                            ))}
                          </div>
                          <span className="text-[10px] font-bold text-muted-foreground">Pg {pageData.pageNumber}</span>
                          <span className="text-[10px] font-medium bg-muted px-1 rounded">{pageData.rects.length} box{pageData.rects.length !== 1 ? 'es' : ''}</span>
                        </div>
                      ))}
                      {template.pages.length > 4 && (
                        <div className="flex flex-col items-center justify-center w-12 h-16 bg-muted/30 border border-dashed border-border rounded">
                          <span className="text-xs font-bold text-muted-foreground">
                            +{template.pages.length - 4}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between pt-4 border-t border-border">
                    <div className="flex items-center space-x-2">
                      <Checkbox 
                        id={`active-${template.id}`} 
                        checked={template.active}
                        onCheckedChange={(checked) => {
                          updateTemplate.mutate({ 
                            id: template.id, 
                            data: { active: !!checked } 
                          }, {
                            onSuccess: () => queryClient.invalidateQueries({ queryKey: getListManufacturerRedactionTemplatesQueryKey() })
                          });
                        }}
                      />
                      <label
                        htmlFor={`active-${template.id}`}
                        className="text-sm font-bold leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                      >
                        Auto-apply
                      </label>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setDeletingId(template.id)}
                    >
                      <Trash2 className="w-4 h-4 mr-1.5" /> Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Delete Template?
            </DialogTitle>
            <DialogDescription className="font-medium">
              Are you sure you want to delete this template? It will no longer be auto-applied to future manufacturer quotes. Existing quotes will not be affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setDeletingId(null)} className="font-bold">Cancel</Button>
            <Button variant="destructive" onClick={() => deletingId && handleDelete(deletingId)} className="font-bold">
              Yes, delete template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
