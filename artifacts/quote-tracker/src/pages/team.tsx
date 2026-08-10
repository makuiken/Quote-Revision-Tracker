import { useListUsers, useApproveUser, useSetUserRole, useRemoveUser, useGetCurrentUser, getListUsersQueryKey } from "@workspace/api-client-react";
import { Shell } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toaster";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Shield, UserX, UserIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useState } from "react";
import { AppUser } from "@workspace/api-client-react";

export default function TeamPage() {
  const { data: dbUser } = useGetCurrentUser();
  const { data: users, isLoading } = useListUsers();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const approveUser = useApproveUser();
  const setRole = useSetUserRole();
  const removeUser = useRemoveUser();

  const [userToRemove, setUserToRemove] = useState<AppUser | null>(null);

  if (dbUser?.role !== "admin") {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Shield className="w-16 h-16 text-muted-foreground/50 mb-4" />
          <h1 className="text-2xl font-serif font-bold text-foreground mb-2">Admins Only</h1>
          <p className="text-muted-foreground font-medium">You do not have permission to view this page.</p>
        </div>
      </Shell>
    );
  }

  const handleApprove = (userId: number) => {
    approveUser.mutate({ id: userId }, {
      onSuccess: () => {
        toast({ title: "User approved", description: "The user can now access the app." });
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.data?.error || "Failed to approve user.", variant: "destructive" });
      }
    });
  };

  const handleSetRole = (userId: number, role: "admin" | "member") => {
    setRole.mutate({ id: userId, data: { role } }, {
      onSuccess: () => {
        toast({ title: "Role updated", description: `User role changed to ${role}.` });
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.data?.error || "Failed to update role.", variant: "destructive" });
      }
    });
  };

  const handleRemove = () => {
    if (!userToRemove) return;
    removeUser.mutate({ id: userToRemove.id }, {
      onSuccess: () => {
        toast({ title: "User removed", description: "The user has been removed successfully." });
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        setUserToRemove(null);
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err?.data?.error || "Failed to remove user.", variant: "destructive" });
        setUserToRemove(null);
      }
    });
  };

  if (isLoading) {
    return (
      <Shell>
        <div className="p-8 text-center text-muted-foreground">Loading team...</div>
      </Shell>
    );
  }

  const pendingUsers = users?.filter(u => u.status === "pending") || [];
  const approvedUsers = users?.filter(u => u.status === "approved") || [];

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-3xl font-serif font-bold text-primary mb-2">Team Management</h1>
        <p className="text-muted-foreground font-medium">Manage access and roles for the sales team.</p>
      </div>

      <div className="space-y-8">
        {pendingUsers.length > 0 && (
          <Card className="border-secondary/30 bg-secondary/5">
            <CardHeader className="pb-4">
              <CardTitle className="text-secondary flex items-center gap-2">
                <AlertCircle className="w-5 h-5" /> Pending Requests
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-border/50">
                {pendingUsers.map(user => (
                  <div key={user.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 first:pt-0 last:pb-0">
                    <div>
                      <p className="font-bold text-foreground text-lg">{user.name}</p>
                      <p className="text-muted-foreground text-sm font-medium">{user.email}</p>
                      <p className="text-xs text-muted-foreground mt-1">Requested {format(new Date(user.createdAt), "MMM d, yyyy")}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button onClick={() => setUserToRemove(user)} variant="outline" className="text-destructive hover:text-destructive/90 hover:bg-destructive/10">
                        Reject
                      </Button>
                      <Button onClick={() => handleApprove(user.id)} className="bg-primary hover:bg-primary/90">
                        <Check className="w-4 h-4 mr-2" /> Approve
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Team Members</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {approvedUsers.map(user => (
                <div key={user.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 first:pt-0 last:pb-0">
                  <div>
                    <div className="flex items-center gap-3">
                      <p className="font-bold text-foreground text-lg">{user.name}</p>
                      {user.role === "admin" ? (
                        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">Admin</Badge>
                      ) : (
                        <Badge variant="outline" className="bg-muted text-muted-foreground">Member</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-sm font-medium">{user.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {user.role === "admin" ? (
                      <Button onClick={() => handleSetRole(user.id, "member")} variant="outline" size="sm" className="bg-card">
                        Make Member
                      </Button>
                    ) : (
                      <Button onClick={() => handleSetRole(user.id, "admin")} variant="outline" size="sm" className="bg-card">
                        Make Admin
                      </Button>
                    )}
                    <Button onClick={() => setUserToRemove(user)} variant="ghost" size="sm" className="text-destructive hover:text-destructive/90 hover:bg-destructive/10">
                      <UserX className="w-4 h-4 mr-2" /> Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!userToRemove} onOpenChange={(open) => !open && setUserToRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <AlertCircle className="w-5 h-5" /> Remove User
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-4">
              Are you sure you want to remove <strong>{userToRemove?.name}</strong>? This will permanently delete their login access to the tracker.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={() => setUserToRemove(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRemove} disabled={removeUser.isPending}>
              {removeUser.isPending ? "Removing..." : "Remove User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}